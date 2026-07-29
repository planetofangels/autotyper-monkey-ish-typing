// ==UserScript==
// @name         autocorrect
// @namespace    http://tampermonkey.net/
// @version      23.0
// @description  simple as that
// @author       mirai
// @match        https://monkeytype.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    let isActive = false;
    let currentIndex = 0;
    let currentWord = null;
    let testStarted = false;
    let spaceTimeout = null;
    let spaceScheduled = false;
    let waitingForWordChange = false;
    let enabled = true;
    let keyQueue = [];
    let processingQueue = false;
    let lastTypedChar = '';
    let resultVisible = false;
    let abortFlag = false; 
  
    // --- Config ---
    const MIN_DELAY = 19;
    const MAX_DELAY = 48;
    const REPEATED_MIN_DELAY = 70;
    const REPEATED_MAX_DELAY = 120;
    const TYPO_CHANCE = 0.02;
    const DIR_UP_CHANCE = 0.2;
    const DIR_DOWN_CHANCE = 0.2;

    // qwertz, can be switched to qwerty (swap z and y i suppose) used to simulate typos in l:33
    const ROWS = [
        ['q','w','e','r','t','z','u','i','o','p'],
        ['a','s','d','f','g','h','j','k','l'],
        ['y','x','c','v','b','n','m']
    ];

    function getNeighbors(char) {
        const lower = char.toLowerCase();
        let neighbors = [];
        for (let r = 0; r < ROWS.length; r++) {
            const row = ROWS[r];
            const idx = row.indexOf(lower);
            if (idx !== -1) {
                if (idx > 0) neighbors.push(row[idx - 1]);
                if (idx < row.length - 1) neighbors.push(row[idx + 1]);
                const above = (r > 0) ? ROWS[r - 1] : null;
                const below = (r < ROWS.length - 1) ? ROWS[r + 1] : null;
                if (above) {
                    if (idx < above.length) neighbors.push(above[idx]);
                    else if (above.length > 0) neighbors.push(above[above.length - 1]);
                }
                if (below) {
                    if (idx < below.length) neighbors.push(below[idx]);
                    else if (below.length > 0) neighbors.push(below[below.length - 1]);
                }
                break;
            }
        }
        return neighbors.filter(n => n && n !== lower);
    }

    function getRandomDelay() {
        return Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
    }

    function getRepeatedDelay() {
        return Math.floor(Math.random() * (REPEATED_MAX_DELAY - REPEATED_MIN_DELAY + 1)) + REPEATED_MIN_DELAY;
    }

    function getTypoChar(correctChar) {
        const neighbors = getNeighbors(correctChar);
        if (neighbors.length === 0) return correctChar;

        const lower = correctChar.toLowerCase();
        let upCandidates = [], downCandidates = [], leftCandidates = [], rightCandidates = [];
        let rowIdx = -1, colIdx = -1;
        for (let r = 0; r < ROWS.length; r++) {
            const c = ROWS[r].indexOf(lower);
            if (c !== -1) { rowIdx = r; colIdx = c; break; }
        }
        if (rowIdx === -1) return neighbors[Math.floor(Math.random() * neighbors.length)];

        for (const n of neighbors) {
            let nRow = -1, nCol = -1;
            for (let r = 0; r < ROWS.length; r++) {
                const c = ROWS[r].indexOf(n);
                if (c !== -1) { nRow = r; nCol = c; break; }
            }
            if (nRow === -1) continue;
            if (nRow < rowIdx) upCandidates.push(n);
            else if (nRow > rowIdx) downCandidates.push(n);
            else {
                if (nCol < colIdx) leftCandidates.push(n);
                else if (nCol > colIdx) rightCandidates.push(n);
            }
        }

        if (upCandidates.length > 0 && Math.random() < DIR_UP_CHANCE) {
            return upCandidates[Math.floor(Math.random() * upCandidates.length)];
        }
        if (downCandidates.length > 0 && Math.random() < DIR_DOWN_CHANCE) {
            return downCandidates[Math.floor(Math.random() * downCandidates.length)];
        }
        const lr = leftCandidates.concat(rightCandidates);
        if (lr.length > 0) {
            return lr[Math.floor(Math.random() * lr.length)];
        }
        return neighbors[Math.floor(Math.random() * neighbors.length)];
    }

    function getInputElement() {
        return document.querySelector('#wordsInput') || document.querySelector('.input');
    }

    function getActiveWord() {
        return document.querySelector('.word.active');
    }

    function getLetters(wordElement) {
        if (!wordElement) return [];
        return wordElement.querySelectorAll('letter');
    }

    function typeLetter(char) {
        const input = getInputElement();
        if (!input) return false;
        input.focus();
        input.value += char;

        const inputEvent = new InputEvent('input', {
            data: char,
            inputType: 'insertText',
            bubbles: true,
            cancelable: true,
            composed: true
        });
        input.dispatchEvent(inputEvent);

        const keydown = new KeyboardEvent('keydown', { key: char, code: 'Key' + char.toUpperCase(), bubbles: true });
        const keyup = new KeyboardEvent('keyup', { key: char, code: 'Key' + char.toUpperCase(), bubbles: true });
        input.dispatchEvent(keydown);
        input.dispatchEvent(keyup);
        return true;
    }

    function typeSpace() {
        const input = getInputElement();
        if (!input) return false;
        input.focus();
        input.value += ' ';

        const inputEvent = new InputEvent('input', {
            data: ' ',
            inputType: 'insertText',
            bubbles: true,
            cancelable: true,
            composed: true
        });
        input.dispatchEvent(inputEvent);
        const keydown = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true });
        const keyup = new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true });
        input.dispatchEvent(keydown);
        input.dispatchEvent(keyup);
        return true;
    }

    function processNextKey() {
        if (!enabled || processingQueue || keyQueue.length === 0) return;
        if (waitingForWordChange) return;
        if (resultVisible || abortFlag) return;

        processingQueue = true;

        if (spaceTimeout) {
            clearTimeout(spaceTimeout);
            spaceTimeout = null;
            spaceScheduled = false;
        }

        const word = getActiveWord();
        if (!word) {
            processingQueue = false;
            keyQueue.shift();
            setTimeout(processNextKey, 10);
            return;
        }

        if (word !== currentWord) {
            currentWord = word;
            currentIndex = 0;
            lastTypedChar = '';
            spaceScheduled = false;
            waitingForWordChange = false;
        }

        const letters = getLetters(word);
        if (letters.length === 0) {
            processingQueue = false;
            keyQueue.shift();
            setTimeout(processNextKey, 10);
            return;
        }

        if (currentIndex >= letters.length) {
            if (!spaceScheduled) {
                spaceScheduled = true;
                spaceTimeout = setTimeout(() => {
                    if (abortFlag || resultVisible) {
                        processingQueue = false;
                        keyQueue.shift();
                        return;
                    }
                    const currentWordNow = getActiveWord();
                    if (currentWordNow === word) {
                        typeSpace();
                        lastTypedChar = ' ';
                        waitingForWordChange = true;
                        currentIndex = 0;
                    }
                    spaceTimeout = null;
                    spaceScheduled = false;
                    processingQueue = false;
                    keyQueue.shift();
                    if (!waitingForWordChange && !abortFlag) {
                        setTimeout(processNextKey, 5);
                    }
                }, 5);
            }
            return;
        }

        const correctChar = letters[currentIndex].textContent;
        let charToType = correctChar;
        if (Math.random() < TYPO_CHANCE) {
            const typo = getTypoChar(correctChar);
            if (typo && typo !== correctChar) {
                charToType = typo;
                console.log(`Typo: typed '${typo}' instead of '${correctChar}'`);
            }
        }

        const isRepeated = (charToType === lastTypedChar);
        const delay = isRepeated ? getRepeatedDelay() : getRandomDelay();

        setTimeout(() => {
            // Check abort flag before typing
            if (abortFlag || resultVisible) {
                processingQueue = false;
                keyQueue.shift();
                return;
            }
            typeLetter(charToType);
            lastTypedChar = charToType;
            currentIndex++;

            keyQueue.shift();
            processingQueue = false;
            setTimeout(processNextKey, 10);
        }, delay);
    }

    function startBot() {
        if (isActive) return;
        isActive = true;
        currentIndex = 0;
        currentWord = null;
        testStarted = false;
        keyQueue = [];
        lastTypedChar = '';
        spaceScheduled = false;
        waitingForWordChange = false;
        resultVisible = false;
        abortFlag = false; // reset abort flag breaks some stuff i suppose

        const input = getInputElement();
        if (input) {
            input.value = '';
            input.focus();
        }

        const word = getActiveWord();
        if (word) {
            currentWord = word;
            currentIndex = 0;
            lastTypedChar = '';
            testStarted = true;
            console.log('ready');
            processNextKey();
        } else {
            const startBtn = document.querySelector('button[data-start]');
            if (startBtn && !startBtn.classList.contains('hidden')) {
                startBtn.click();
            }
            const checkFirstWord = setInterval(() => {
                const w = getActiveWord();
                if (w) {
                    currentWord = w;
                    currentIndex = 0;
                    lastTypedChar = '';
                    testStarted = true;
                    clearInterval(checkFirstWord);
                    console.log('ready once again');
                    processNextKey();
                }
            }, 100);
        }
    }

    // eydown listener
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && (e.key === 'j' || e.key === 'J')) {
            e.preventDefault();
            enabled = false;
            console.log('AutoTyper disabled (Ctrl+J)');
            keyQueue = [];
            processingQueue = false;
            waitingForWordChange = false;
            lastTypedChar = '';
            abortFlag = true; // abort any pending actions
            if (spaceTimeout) {
                clearTimeout(spaceTimeout);
                spaceTimeout = null;
                spaceScheduled = false;
            }
            return;
        }
        if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            enabled = true;
            console.log('AutoTyper enabled (Ctrl+K)');
            if (isActive && testStarted && keyQueue.length > 0 && !resultVisible) {
                processNextKey();
            }
            return;
        }

        if (!enabled) {
            return;
        }

        if (e.ctrlKey) {
            return;
        }

        if (resultVisible) {
            return;
        }

        if (e.key === ' ') {
            e.preventDefault();
            return;
        }

        if (e.key.length > 1) {
            return;
        }

        if (!e.isTrusted) return;

        e.preventDefault();

        if (!isActive) {
            startBot();
            keyQueue.push(e.key);
            setTimeout(processNextKey, 200);
            return;
        }

        if (testStarted) {
            keyQueue.push(e.key);
            if (!processingQueue && !waitingForWordChange && !abortFlag) {
                processNextKey();
            }
        }
    }, true);

  // broken stuff but works somewhat
    const observer = new MutationObserver(() => {
        const word = getActiveWord();
        if (word && word !== currentWord) {
            if (resultVisible) {
                resultVisible = false;
                abortFlag = false;
                console.log('new test detected');
                startBot();
            } else {
                currentWord = word;
                currentIndex = 0;
                lastTypedChar = '';
                waitingForWordChange = false;
                if (spaceTimeout) {
                    clearTimeout(spaceTimeout);
                    spaceTimeout = null;
                    spaceScheduled = false;
                }
                if (!processingQueue && keyQueue.length > 0 && enabled && !abortFlag) {
                    processNextKey();
                }
            }
        }

      if (document.querySelector('.result')) {
            resultVisible = true;
            abortFlag = true; 
            isActive = false;
            currentIndex = 0;
            currentWord = null;
            testStarted = false;
            keyQueue = [];
            lastTypedChar = '';
            waitingForWordChange = false;
            if (spaceTimeout) {
                clearTimeout(spaceTimeout);
                spaceTimeout = null;
                spaceScheduled = false;
            }
            console.log('finished');
        }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });

    console.log('MEOOOWOWWW!!!!!!');
})();
