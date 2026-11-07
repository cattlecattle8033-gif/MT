// ==UserScript==
// @name         龍盈科技【MT百家樂】量子預測引擎
// @namespace    https://mtbaccarat.local/
// @version      2.0.0
// @description  百家樂路單分析、量子預測、玻璃擬態 UI 與自動下注框架（支援手機端 iframe 深度穿透）
// @author       MT Baccarat Engine
// @match        *://*/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==
// 【手機端相容性說明】@match 設為 *://*/* 並省略 @noframes，確保腳本能在遊戲頁面的所有子
// iframe（包含手機端 Stay 腳本注入環境）內同步執行；@run-at document-start 讓腳本盡早注入，
// 降低因頁面延遲載入導致偵測失敗的機率；@grant unsafeWindow 允許在必要時存取未受隔離的
// 真實頁面 window（本腳本目前仍以標準 window API 為主，僅保留此授權作為手機端相容性備援）。

(function () {
    'use strict';

    const ENGINE_INSTANCE_KEY = '__mtBaccaratEngineInstance__';
    if (typeof window !== 'undefined') {
        try {
            const hostWindow = window.top && window.top.document ? window.top : window;
            if (hostWindow[ENGINE_INSTANCE_KEY]) return;
            hostWindow[ENGINE_INSTANCE_KEY] = Object.freeze({ startedAt: Date.now() });
            const stalePanel = hostWindow.document && hostWindow.document.getElementById('baccarat-ultimate-engine');
            if (stalePanel) stalePanel.remove();
        } catch (error) {
            if (window[ENGINE_INSTANCE_KEY]) return;
            window[ENGINE_INSTANCE_KEY] = Object.freeze({ startedAt: Date.now() });
        }
    }

    // 核心純函式 API：只提供計算與分析，不會操作投注或修改頁面 UI。
    const BACCARAT_API_VERSION = '3.0.0';
    const OUTCOMES = Object.freeze(['莊', '閒', '和']);
    // 【3.0.0 統一先驗】百家樂理論基準（8 副牌）：莊 45.86%、閒 44.62%、和 9.52%；排除和局後莊 50.68%、閒 49.32%。
    // 所有模型的 Laplace 平滑先驗、校準收縮目標與牌靴偏差基準都以此為準，而不是均勻分布 (1/3, 1/3, 1/3)。
    // 往均勻分布收縮會系統性高估和局、並抹掉莊的結構性優勢——那是先驗選錯，不是資料告訴我們的事。
    const BACCARAT_PRIOR = Object.freeze({ '莊': 0.4586, '閒': 0.4462, '和': 0.0952 });
    const BACCARAT_PRIOR_BANKER_RATE = BACCARAT_PRIOR['莊'] / (BACCARAT_PRIOR['莊'] + BACCARAT_PRIOR['閒']);
    /** @type {Readonly<Record<string, number|string>>} */
    const CONFIG = Object.freeze({
        BRAND_NAME: '龍盈科技【MT百家樂】',
        SCAN_INTERVAL: 300,
        EXPIRE_DATE: '2026-11-30'
    });
    const ULTIMATE_CONFIG = Object.freeze({
        MAX_HISTORY: 500,
        MAX_DATA_LOGS: 300,
        DEFAULT_MAX_LOSS_STREAK: 10,
        LONG_TREND_MIN_RUN: 4,
        STABLE_ALTERNATION_MIN_ROUNDS: 5,
        STABLE_ALTERNATION_RATIO: 0.8,
        OBSERVATION_ROUNDS: 3,
        SCAN_INTERVAL_MS: 300,
        HEADER_TIME_INTERVAL_MS: 1000,
        KELLY_CAP: 0.05,
        KELLY_FRACTION: 0.25,
        KALMAN_PROCESS_NOISE: 0.04,
        KALMAN_MEASUREMENT_NOISE: 0.12,
        ADAPTIVE_WIN_RATE: 0.55,
        STALE_DIRECTION_STREAK: 3,
        STALE_DIRECTION_MARGIN: 0.04,
        ENTROPY_WINDOW: 20,
        RANDOM_ENTROPY_THRESHOLD: 1.35,
        MIN_ADAPTIVE_MARGIN: 0.015,
        ADAPTIVE_MARGIN_FACTOR: 0.65,
        MIN_ADAPTIVE_AGREEMENT: 0.4,
        ADAPTIVE_AGREEMENT_FACTOR: 0.8,
        SHOE_MIN_ROUNDS: 35,
        SHOE_BIAS_CAP: 0.15,
        SHORT_WINDOW: 5,
        MEDIUM_WINDOW: 15,
        SHOE_OPENING_ROUNDS: 10,
        SHOE_OPENING_MARGIN_MULTIPLIER: 1.10,
        SHOE_ENDING_ROUNDS: 60,
        SHOE_ENDING_KELLY_CAP: 0.03,
        // 【3.0.0 資訊熵動態防禦】近 20 局二元 Shannon 熵 ≥ 0.985（約等於莊閒各半、毫無偏向）
        // 且沒有任何好路共振時，取消真實訊號、僅保留灰色參考方向；有好路共振則不攔截。
        HIGH_ENTROPY_THRESHOLD: 0.985,
        MAX_CONSENSUS_DISAGREEMENT: 0.93,
        PLAYER_EV_MARGIN_BONUS: 0.005,
        // 【3.0.0 自適應真實訊號門檻】
        // 常規局勢：淨邊際 margin ≥ 4.2% 且核心模型共識 ≥ 59% 才算真實訊號（高標準）。
        // 好路降載：動態馬可夫矩陣或下三路共振偵測到當前靴牌有顯著規律（長龍、穩定單跳、
        // 某狀態轉移偏向 ≥ 52%）時，margin 門檻彈性降至 2.5%，避免長期卡在觀望。
        REAL_SIGNAL_BASE_MARGIN: 0.042,
        REAL_SIGNAL_RELAXED_MARGIN: 0.025,
        REAL_SIGNAL_CORE_AGREEMENT: 0.59,
        // 【3.0.0 動態馬可夫狀態矩陣】狀態轉移在當前靴牌中的偏向勝率達此值、
        // 且樣本數達 MIN_SAMPLES，才視為顯著規律並提高該路型模型投票權重（最多 +100%）。
        MARKOV_STATE_EDGE_THRESHOLD: 0.52,
        MARKOV_STATE_MIN_SAMPLES: 5,
        MARKOV_STATE_MIN_AGREEMENT: 0.6,
        // 加成上限 0.5：離線雙軌測試（真實 606 局 + 固定種子隨機 1500 局）顯示 0／0.5／1.0 三者差距
        // 都在抽樣誤差內；採 0.5 讓路型證據有話語權，但不至於讓單一靴內巧合主導整體方向。
        MARKOV_STATE_MAX_BOOST: 0.5,
        // 【莊向偏好 Banker Tilt】排除和局後，莊的長期勝率為 50.68%、閒為 49.32%，
        // 兩者相差 1.36%。也就是說每一次「押閒」都等於主動接受一個比押莊更差的期望值，
        // 只有當模型對閒的判斷明顯夠強時，偏離莊才有意義。
        // 本參數即為該「明顯夠強」的門檻：當推薦方向為閒、但 P(閒) - P(莊) 小於此值時，
        // 視為模型並未取得足以抵銷莊家結構性優勢的證據，改推薦莊。
        // 離線實測（30 組 × 484 局隨機牌局，共約 14,520 局）：
        //   0（不啟用）→ 50.35%／0.04 → 50.59%／0.08 → 50.82%／一律押莊 → 50.64%。
        // 採用 0.04 是為了在命中率與推薦方向多樣性之間取得平衡：
        // 當模型對閒有 4% 以上的機率優勢時仍會正常推薦閒，不會讓面板永遠只顯示莊。
        // 注意：此調整提升的是統計期望值，並非對單場結果的保證。
        BANKER_TILT_MARGIN: 0.04,
        // 【修正】連敗達到 8 局才會觸發 Shadow Betting（策略模擬觀望），
        // 但倍投（martingale）演算法本身的風控上限 DEFAULT_MAX_LOSS_STREAK 是 10 局，
        // 兩者門檻不一致，導致倍投序列還沒跑完就被提前打斷。改為 8 局，讓倍投有更合理的緩衝空間，
        // 同時仍保留連續虧損時的風控停損保護，避免無限制加倍。
        SHADOW_TRIGGER_LOSSES: 8,
        SHADOW_MIN_WIN_RATE: 0.5,
        SHADOW_RECOVERY_STREAK: 2,
        MODEL_PERFORMANCE_WINDOW: 40,
        // 【持久化歷史上限】面板每局真實結果會自動寫入 localStorage（跨分頁/跨重新整理保留），
        // 供 runPersistedBacktest 之類的離線回測工具使用。3000 局約為 30-40 靴牌，
        // 足以支撐有意義的樣本數，同時避免 localStorage 無限增長造成效能問題。
        PERSISTED_OUTCOME_CAP: 3000
    });
    const assertUltimateConfig = (config) => {
        const positiveIntegers = ['MAX_HISTORY', 'MAX_DATA_LOGS', 'DEFAULT_MAX_LOSS_STREAK', 'LONG_TREND_MIN_RUN', 'STABLE_ALTERNATION_MIN_ROUNDS', 'OBSERVATION_ROUNDS', 'SCAN_INTERVAL_MS', 'HEADER_TIME_INTERVAL_MS', 'STALE_DIRECTION_STREAK', 'ENTROPY_WINDOW', 'SHOE_MIN_ROUNDS', 'SHORT_WINDOW', 'MEDIUM_WINDOW', 'SHADOW_TRIGGER_LOSSES', 'SHADOW_RECOVERY_STREAK', 'MODEL_PERFORMANCE_WINDOW', 'SHOE_OPENING_ROUNDS', 'SHOE_ENDING_ROUNDS', 'PERSISTED_OUTCOME_CAP', 'MARKOV_STATE_MIN_SAMPLES'];
        const boundedRatios = ['STABLE_ALTERNATION_RATIO', 'KELLY_CAP', 'KELLY_FRACTION', 'KALMAN_PROCESS_NOISE', 'KALMAN_MEASUREMENT_NOISE', 'ADAPTIVE_WIN_RATE', 'STALE_DIRECTION_MARGIN', 'SHOE_ENDING_KELLY_CAP', 'HIGH_ENTROPY_THRESHOLD', 'MAX_CONSENSUS_DISAGREEMENT', 'PLAYER_EV_MARGIN_BONUS', 'BANKER_TILT_MARGIN', 'REAL_SIGNAL_BASE_MARGIN', 'REAL_SIGNAL_RELAXED_MARGIN', 'REAL_SIGNAL_CORE_AGREEMENT', 'MARKOV_STATE_EDGE_THRESHOLD', 'MARKOV_STATE_MIN_AGREEMENT'];
        positiveIntegers.forEach(key => { if (!Number.isInteger(config[key]) || config[key] <= 0) throw new RangeError('ULTIMATE_CONFIG.' + key + ' 必須是正整數'); });
        boundedRatios.forEach(key => { if (!Number.isFinite(config[key]) || config[key] < 0 || config[key] > 1) throw new RangeError('ULTIMATE_CONFIG.' + key + ' 必須介於 0 至 1'); });
        if (!Number.isFinite(config.SHOE_OPENING_MARGIN_MULTIPLIER) || config.SHOE_OPENING_MARGIN_MULTIPLIER < 1 || config.SHOE_OPENING_MARGIN_MULTIPLIER > 2) throw new RangeError('ULTIMATE_CONFIG.SHOE_OPENING_MARGIN_MULTIPLIER 必須介於 1 至 2');
        if (config.KELLY_CAP > 0.05 || config.MAX_HISTORY < config.OBSERVATION_ROUNDS) throw new RangeError('ULTIMATE_CONFIG 邊界不一致');
        if (config.REAL_SIGNAL_RELAXED_MARGIN > config.REAL_SIGNAL_BASE_MARGIN) throw new RangeError('ULTIMATE_CONFIG.REAL_SIGNAL_RELAXED_MARGIN 不可高於 REAL_SIGNAL_BASE_MARGIN');
        if (config.MARKOV_STATE_EDGE_THRESHOLD < 0.5) throw new RangeError('ULTIMATE_CONFIG.MARKOV_STATE_EDGE_THRESHOLD 必須至少為 0.5');
        if (!Number.isFinite(config.MARKOV_STATE_MAX_BOOST) || config.MARKOV_STATE_MAX_BOOST < 0 || config.MARKOV_STATE_MAX_BOOST > 2) throw new RangeError('ULTIMATE_CONFIG.MARKOV_STATE_MAX_BOOST 必須介於 0 至 2');
        return config;
    };
    assertUltimateConfig(ULTIMATE_CONFIG);
    const MAX_HISTORY = ULTIMATE_CONFIG.MAX_HISTORY;
    const MAX_DATA_LOGS = ULTIMATE_CONFIG.MAX_DATA_LOGS;
    const DEFAULT_MAX_LOSS_STREAK = ULTIMATE_CONFIG.DEFAULT_MAX_LOSS_STREAK;
    const safeDebug = (...args) => {
        try {
            if (typeof console !== 'undefined' && typeof console.debug === 'function') console.debug(...args);
        } catch (_) {
            // 診斷輸出不可影響主流程。
        }
    };
    // 【Bug 修正】DATA_LOG_KEY 先前從未定義，導致 persistDataLog 內部
    // localStorage.getItem(DATA_LOG_KEY) 觸發 ReferenceError（非 localStorage 本身的問題），
    // 每次寫入日誌都會被 catch 攔截並印出錯誤，雖不影響主流程但持續污染 Console。
    const DATA_LOG_KEY = 'mt_baccarat_data_logs';
    const persistDataLog = (entry) => {
        try {
            if (typeof localStorage === 'undefined') return;
            const previous = JSON.parse(localStorage.getItem(DATA_LOG_KEY) || '[]');
            const logs = Array.isArray(previous) ? previous.slice(-(MAX_DATA_LOGS - 1)) : [];
            logs.push(entry);
            localStorage.setItem(DATA_LOG_KEY, JSON.stringify(logs));
        } catch (error) {
            safeDebug('[MT Baccarat] 日誌持久化失敗，已略過本次緩存', error);
        }
    };
    // 【真實歷史自動收集】與上面 persistDataLog（混合事件日誌，300 筆上限、容易被沖掉）
    // 分開維護一份「純結果序列」，專門給 runWalkForwardBacktest 這類回測工具使用。
    // 好處：
    //   1. 面板每局真實結果會自動累積，不需要使用者手動複製貼上或匯出。
    //   2. 跨分頁、跨重新整理仍會保留（只要瀏覽器 localStorage 沒被清除），
    //      解決了「gameSequence 只存在記憶體、關閉分頁就歸零」的問題。
    //   3. 獨立於事件日誌，不會被 prediction-result / new-round 等其他日誌排擠掉。
    const PERSISTED_OUTCOME_KEY = 'mt_baccarat_outcome_history';
    const isValidOutcomeToken = (value) => value === '莊' || value === '閒' || value === '和';
    const getPersistedOutcomeHistory = () => {
        try {
            if (typeof localStorage === 'undefined') return [];
            const raw = localStorage.getItem(PERSISTED_OUTCOME_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            // 防禦：localStorage 內容可能因版本升級、其他分頁寫入競態、或使用者手動編輯而毀損，
            // 一律過濾為合法的莊/閒/和字串，避免污染下游回測統計或造成例外。
            return Array.isArray(parsed) ? parsed.filter(isValidOutcomeToken) : [];
        } catch (error) {
            safeDebug('[MT Baccarat] 讀取持久化歷史失敗，視為空歷史', error);
            return [];
        }
    };
    const appendPersistedOutcome = (outcome) => {
        try {
            if (!isValidOutcomeToken(outcome) || typeof localStorage === 'undefined') return getPersistedOutcomeHistory();
            const history = getPersistedOutcomeHistory();
            history.push(outcome);
            const cap = ULTIMATE_CONFIG.PERSISTED_OUTCOME_CAP;
            if (history.length > cap) history.splice(0, history.length - cap);
            localStorage.setItem(PERSISTED_OUTCOME_KEY, JSON.stringify(history));
            return history;
        } catch (error) {
            safeDebug('[MT Baccarat] 寫入持久化歷史失敗，已略過本次紀錄（不影響面板主流程）', error);
            return [];
        }
    };
    const clearPersistedOutcomeHistory = () => {
        try {
            if (typeof localStorage === 'undefined') return;
            localStorage.removeItem(PERSISTED_OUTCOME_KEY);
        } catch (error) {
            safeDebug('[MT Baccarat] 清除持久化歷史失敗', error);
        }
    };
    const writeDataLog = (event, details = {}) => {
        try {
            const entry = Object.freeze({ event, timestamp: new Date().toISOString(), ...details });
            try {
                if (typeof console !== 'undefined' && typeof console.log === 'function') console.log(`[MT Baccarat][${event}]`, entry);
            } catch (error) {
                safeDebug('[MT Baccarat] Console 日誌失敗', error);
            }
            if (typeof setTimeout === 'function') setTimeout(() => persistDataLog(entry), 0);
            return entry;
        } catch (error) {
            safeDebug('[MT Baccarat] 日誌建立失敗，已保留目前執行流程', error);
        }
        return null;
    };
    const assertFiniteNonNegative = (value, name) => {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) throw new TypeError(`${name} 必須是非負有限數字`);
        return number;
    };
    const toCardPoint = (card) => {
        const value = typeof card === 'string' ? card.trim().toUpperCase() : card;
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 13) return value >= 10 ? 0 : value;
        if (value === 'A') return 1;
        if (['10', 'J', 'Q', 'K'].includes(String(value))) return 0;
        const number = Number(value);
        if (Number.isInteger(number) && number >= 0 && number <= 9) return number;
        throw new TypeError('牌值必須是 A、2-9、10/J/Q/K 或 0-13 的整數');
    };
    const calculateCardPoints = (cards) => {
        if (!Array.isArray(cards) || cards.length === 0 || cards.length > 3) throw new TypeError('牌組必須包含 1 至 3 張牌');
        return cards.reduce((sum, card) => sum + toCardPoint(card), 0) % 10;
    };
    const bankerDraws = (bankerTotal, playerTotal, playerThirdCard = null) => {
        const banker = assertFiniteNonNegative(bankerTotal, '莊家牌點');
        const player = assertFiniteNonNegative(playerTotal, '閒家牌點');
        if (banker > 9 || player > 9) throw new RangeError('牌點必須介於 0 至 9');
        if (playerThirdCard === null || playerThirdCard === undefined) return banker <= 5;
        const third = toCardPoint(playerThirdCard);
        if (banker <= 2) return true;
        if (banker === 3) return third !== 8;
        if (banker === 4) return third >= 2 && third <= 7;
        if (banker === 5) return third >= 4 && third <= 7;
        if (banker === 6) return third === 6 || third === 7;
        return false;
    };
    const analyzeHand = (hand) => {
        if (!hand || typeof hand !== 'object') throw new TypeError('牌局資料必須是物件');
        const bankerCards = hand.banker || hand.bankerCards;
        const playerCards = hand.player || hand.playerCards;
        if (!Array.isArray(bankerCards) || !Array.isArray(playerCards) || bankerCards.length < 2 || playerCards.length < 2) throw new TypeError('莊、閒至少各需要兩張牌');
        const bankerTotal = calculateCardPoints(bankerCards);
        const playerTotal = calculateCardPoints(playerCards);
        const playerThirdCard = playerCards.length >= 3 ? toCardPoint(playerCards[2]) : null;
        const bankerShouldDraw = bankerDraws(bankerTotal, playerTotal, playerThirdCard);
        const outcome = bankerTotal === playerTotal ? '和' : bankerTotal > playerTotal ? '莊' : '閒';
        return Object.freeze({ bankerTotal, playerTotal, playerThirdCard, bankerShouldDraw, outcome });
    };
    const validOutcome = (outcome) => OUTCOMES.includes(outcome);
    const normalizeHistory = (history) => {
        if (!Array.isArray(history)) throw new TypeError('歷史資料必須是陣列');
        return history.filter(validOutcome).slice(-MAX_HISTORY);
    };
    // 【回測專用】一般即時預測（normalizeHistory）刻意只保留最近 MAX_HISTORY（500）局，
    // 這是為了限制記憶體與即時運算量；但 runWalkForwardBacktest／runPersistedBacktest
    // 是離線分析工具，若沿用同一個 500 局上限，會讓面板持久化收集的更長歷史（最多 3000 局）
    // 在回測時被無聲截斷，統計樣本數遠低於使用者實際累積的局數。因此回測改用「只過濾合法值、
    // 不限制長度」的版本；每一局預測仍會透過 getEnsemblePrediction 內部的 normalizeHistory
    // 自動只採用該局之前最近 500 局作為特徵輸入，行為與即時預測一致，只是評估的「總局數」不再被截短。
    const filterValidOutcomesForBacktest = (history) => {
        if (!Array.isArray(history)) throw new TypeError('歷史資料必須是陣列');
        return history.filter(validOutcome);
    };
    const buildBigRoad = (history) => {
        const columns = [];
        normalizeHistory(history).forEach((outcome) => {
            if (outcome === '和') {
                const column = columns[columns.length - 1];
                if (column) column.ties = (column.ties || 0) + 1;
                return;
            }
            const last = columns[columns.length - 1];
            if (!last || last.color !== outcome) columns.push({ color: outcome, cells: [{ row: 0, color: outcome }], ties: 0 });
            else {
                const row = Math.min(5, last.cells.length);
                last.cells.push({ row, color: outcome });
            }
        });
        return columns.map((column, index) => ({ column: index, color: column.color, cells: column.cells.slice(), ties: column.ties || 0 }));
    };
    // 計算下三路特定大路節點的紅藍顏色（offset: 1=大眼仔路, 2=小路, 3=曱甴路）
    // 大路座標：col 為列索引（0-based），row 為該列第幾個（0-based）
    const getDerivedRoadCellColor = (bigRoad, col, row, offset) => {
        if (!Array.isArray(bigRoad) || col <= offset) return null;
        if (row === 0) {
            // 新列第一粒：比較前 1 列與前 (offset + 1) 列的長度是否相等（齊整=紅，不齊整=藍）
            const prevCol1 = bigRoad[col - 1];
            const prevColOffset = bigRoad[col - 1 - offset];
            if (!prevCol1 || !prevColOffset) return null;
            return prevCol1.cells.length === prevColOffset.cells.length ? '紅' : '藍';
        } else {
            // 同列續出（第 2 粒及以後）：比較前 offset 列有無拍拍黐（有子/直落=紅，落空拐彎=藍）
            const targetCol = bigRoad[col - offset];
            if (!targetCol) return null;
            const targetLen = targetCol.cells.length;
            if (targetLen >= row + 1) {
                // 前列在 row 位置有子（有對應、齊頭）
                return '紅';
            } else if (targetLen === row) {
                // 前列在 row - 1 有子，但在 row 無子（剛好拐彎落空）
                return '藍';
            } else {
                // 前列在 row - 1 也無子（直落成條延續）
                return '紅';
            }
        }
    };

    // 建立標準百家樂下三路（大眼仔路 offset=1, 小路 offset=2, 曱甴路 offset=3）
    const buildDerivedRoad = (history, offset) => {
        const big = buildBigRoad(history);
        const result = [];
        for (let col = offset; col < big.length; col++) {
            const current = big[col];
            current.cells.forEach((cell, row) => {
                // 啟始點規則：大眼仔路從 (1, 1) 開始，若第 2 列只有 1 粒則從 (2, 0) 開始
                if (col === offset && row === 0) return;
                const color = getDerivedRoadCellColor(big, col, row, offset);
                if (color) {
                    result.push({
                        column: result.length,
                        row: Math.min(5, row),
                        color,
                        source: current.color
                    });
                }
            });
        }
        return result;
    };

    // 莊問路與閒問路模擬器（Inquiry Simulator）：預測下一把開莊或開閒時下三路的紅藍投影
    const simulateRoadInquiry = (history) => {
        try {
            const cleanHistory = normalizeHistory(history);
            const simulateNext = (nextOutcome) => {
                const simulatedHistory = [...cleanHistory, nextOutcome];
                const big = buildBigRoad(simulatedHistory);
                if (big.length === 0) return { bigEye: null, small: null, cockroach: null };
                const lastColIdx = big.length - 1;
                const lastCol = big[lastColIdx];
                const lastRowIdx = lastCol.cells.length - 1;
                return {
                    bigEye: getDerivedRoadCellColor(big, lastColIdx, lastRowIdx, 1),
                    small: getDerivedRoadCellColor(big, lastColIdx, lastRowIdx, 2),
                    cockroach: getDerivedRoadCellColor(big, lastColIdx, lastRowIdx, 3)
                };
            };
            const banker = simulateNext('莊');
            const player = simulateNext('閒');
            const countReds = (inquiry) => Object.values(inquiry).filter(c => c === '紅').length;
            const bankerReds = countReds(banker);
            const playerReds = countReds(player);

            return Object.freeze({
                banker,
                player,
                bankerReds,
                playerReds,
                threeRedsTarget: bankerReds === 3 ? '莊' : playerReds === 3 ? '閒' : null,
                preference: bankerReds > playerReds ? '莊' : playerReds > bankerReds ? '閒' : null,
                differential: Math.abs(bankerReds - playerReds)
            });
        } catch (_) {
            const empty = { bigEye: null, small: null, cockroach: null };
            return Object.freeze({ banker: empty, player: empty, bankerReds: 0, playerReds: 0, threeRedsTarget: null, preference: null, differential: 0 });
        }
    };

    // 多維經典牌路格局識別模組（Pattern Recognizer）
    const analyzeRoadPatterns = (history) => {
        try {
            const outcomes = Array.isArray(history) ? history.filter(validOutcome) : [];
            const big = buildBigRoad(outcomes);
            const colLengths = big.map(c => c.cells.length);
            const totalCols = big.length;
            
            if (totalCols === 0) {
                return Object.freeze({
                    pattern: '無格局',
                    target: null,
                    confidence: 0,
                    details: '局數不足',
                    primary: null,
                    signals: [],
                    patterns: {}
                });
            }
            
            const lastCol = big[totalCols - 1];
            const lastLen = lastCol.cells.length;
            const lastColor = lastCol.color;
            const oppositeColor = lastColor === '莊' ? '閒' : '莊';
            const signals = [];
            const patterns = {};
            const addSignal = (key, pattern, target, confidence, details) => {
                const signal = Object.freeze({ key, pattern, target, confidence, details, active: true });
                patterns[key] = signal;
                signals.push(signal);
            };
            const colorsAlternate = (columns) => columns.length > 1 &&
                columns.slice(1).every((column, index) => column.color !== columns[index].color);
            const recentColumns = (count) => big.slice(-count);
            const bankerColumns = big.filter(column => column.color === '莊');
            const playerColumns = big.filter(column => column.color === '閒');

            if (lastColor === '莊' && lastLen >= ULTIMATE_CONFIG.LONG_TREND_MIN_RUN) {
                addSignal('longBanker', '長莊', '莊', Math.min(0.95, 0.65 + lastLen * 0.05), `莊連續 ${lastLen} 局`);
            }
            if (lastColor === '閒' && lastLen >= ULTIMATE_CONFIG.LONG_TREND_MIN_RUN) {
                addSignal('longPlayer', '長閒', '閒', Math.min(0.95, 0.65 + lastLen * 0.05), `閒連續 ${lastLen} 局`);
            }

            const singleColumns = recentColumns(4);
            if (singleColumns.length === 4 && singleColumns.every(column => column.cells.length === 1) && colorsAlternate(singleColumns)) {
                addSignal('bigRoadSingleJump', '大路單跳', oppositeColor, 0.85, '最近四欄均為單粒且莊閒交替');
            }

            const doubleColumns = recentColumns(3);
            if (doubleColumns.length === 3 &&
                doubleColumns[0].cells.length === 2 &&
                doubleColumns[1].cells.length === 2 &&
                doubleColumns[2].cells.length <= 2 &&
                colorsAlternate(doubleColumns)) {
                const doubleTarget = doubleColumns[2].cells.length === 1 ? lastColor : oppositeColor;
                addSignal('bigRoadDoubleJump', '大路雙跳', doubleTarget, 0.84, '最近欄高符合 2-2 雙跳並推算續粒或換欄');
            }

            const oneHallTwoRooms = recentColumns(4);
            if (oneHallTwoRooms.length === 4 &&
                oneHallTwoRooms.every((column, index) => column.cells.length === (index % 2 === 0 ? 1 : 2)) &&
                colorsAlternate(oneHallTwoRooms)) {
                addSignal('oneHallTwoRooms', '一廳兩房', lastColor, 0.78, '欄高符合 1-2-1-2 且方向交替');
            }

            const recentBanker = bankerColumns.slice(-3);
            const recentPlayer = playerColumns.slice(-3);
            if (recentBanker.length === 3 && recentBanker.every(column => column.cells.length === 1)) {
                addSignal('bankerJump', '逢莊跳', '閒', 0.82, '最近三個莊欄均單粒，逢莊後切換');
            }
            if (recentPlayer.length === 3 && recentPlayer.every(column => column.cells.length === 1)) {
                addSignal('playerJump', '逢閒跳', '莊', 0.82, '最近三個閒欄均單粒，逢閒後切換');
            }

            if (recentBanker.length === 3 && recentBanker.every(column => column.cells.length >= 2)) {
                addSignal('banker連', '逢莊連', '莊', 0.76, '最近三個莊欄均至少兩粒，形成逢莊連出');
            }
            if (recentPlayer.length === 3 && recentPlayer.every(column => column.cells.length >= 2)) {
                addSignal('player連', '逢閒連', '閒', 0.76, '最近三個閒欄均至少兩粒，形成逢閒連出');
            }

            if (totalCols >= 2) {
                const previous = colLengths[totalCols - 2];
                if (previous >= 2 && lastLen < previous) {
                    addSignal('sticky', '拍拍黐', lastColor, 0.75, `前欄 ${previous} 粒、目前 ${lastLen} 粒，預測跟齊`);
                }
            }

            const slopeColumns = recentColumns(3);
            const slopeLengths = slopeColumns.map(column => column.cells.length);
            if (slopeColumns.length === 3 && colorsAlternate(slopeColumns) &&
                (slopeLengths[0] < slopeLengths[1] && slopeLengths[1] < slopeLengths[2])) {
                addSignal('slopeUp', '斜坡路', lastColor, 0.74, `欄高由 ${slopeLengths.join('→')} 逐步上升`);
            } else if (slopeColumns.length === 3 && colorsAlternate(slopeColumns) &&
                (slopeLengths[0] > slopeLengths[1] && slopeLengths[1] > slopeLengths[2])) {
                addSignal('slopeDown', '斜坡路', oppositeColor, 0.74, `欄高由 ${slopeLengths.join('→')} 逐步下降`);
            }

            signals.sort((left, right) => right.confidence - left.confidence);
            const primary = signals[0] || null;
            return Object.freeze({
                pattern: primary ? primary.pattern : '常規過渡',
                target: primary ? primary.target : null,
                confidence: primary ? primary.confidence : 0.5,
                details: primary ? primary.details : '牌路正常過渡',
                primary,
                signals: Object.freeze(signals),
                patterns: Object.freeze(patterns)
            });
        } catch (_) {
            return Object.freeze({
                pattern: '無格局',
                target: null,
                confidence: 0,
                details: '分析異常',
                primary: null,
                signals: [],
                patterns: {}
            });
        }
    };

    const analyzeRoads = (history) => Object.freeze({
        大路: buildBigRoad(history),
        大眼路: buildDerivedRoad(history, 1),
        小路: buildDerivedRoad(history, 2),
        曱甴路: buildDerivedRoad(history, 3),
        問路: simulateRoadInquiry(history),
        格局: analyzeRoadPatterns(history)
    });
    const calculateBinaryEntropy = (history, windowSize = ULTIMATE_CONFIG.ENTROPY_WINDOW) => {
        try {
            const values = Array.isArray(history) ? history.filter(o => o === '莊' || o === '閒').slice(-Math.max(1, Math.floor(windowSize))) : [];
            if (values.length === 0) return 0;
            let bankerCount = 0;
            for (let i = 0; i < values.length; i++) {
                if (values[i] === '莊') bankerCount++;
            }
            const pB = bankerCount / values.length;
            const pP = 1 - pB;
            if (pB === 0 || pP === 0) return 0;
            return -(pB * Math.log2(pB) + pP * Math.log2(pP));
        } catch (_) {
            return 0;
        }
    };
    const calculateConsensusDisagreement = (models) => {
        try {
            if (!Array.isArray(models) || models.length === 0) return 0;
            let bankerWeight = 0;
            let playerWeight = 0;
            let totalWeight = 0;
            models.forEach(entry => {
                const w = (entry && typeof entry.weight === 'number') ? entry.weight : 1;
                totalWeight += w;
                const dist = entry ? entry.distribution : null;
                if (dist && dist['莊'] > dist['閒']) bankerWeight += w;
                else if (dist && dist['閒'] > dist['莊']) playerWeight += w;
            });
            if (totalWeight === 0) return 0;
            const diff = Math.abs(bankerWeight - playerWeight) / totalWeight;
            return 1 - diff;
        } catch (_) {
            return 0;
        }
    };
    const calculateEntropy = (history, windowSize = 20) => {
        try {
            const values = Array.isArray(history) ? history.filter(validOutcome).slice(-Math.max(1, Math.floor(windowSize))) : [];
            if (values.length === 0) return 0;
            const counts = values.reduce((result, outcome) => {
                result[outcome] = (result[outcome] || 0) + 1;
                return result;
            }, {});
            return Object.values(counts).reduce((entropy, count) => {
                const probability = count / values.length;
                return entropy - probability * Math.log2(probability);
            }, 0);
        } catch (_) {
            return 0;
        }
    };
    const kalmanFilterEntropy = (history, previousEstimate = null, previousVariance = 1) => {
        const measurement = calculateEntropy(history, ULTIMATE_CONFIG.ENTROPY_WINDOW);
        const estimate = Number.isFinite(Number(previousEstimate)) ? Number(previousEstimate) : measurement;
        const variance = Number.isFinite(Number(previousVariance)) && previousVariance >= 0 ? Number(previousVariance) : 1;
        const processNoise = ULTIMATE_CONFIG.KALMAN_PROCESS_NOISE;
        const measurementNoise = ULTIMATE_CONFIG.KALMAN_MEASUREMENT_NOISE;
        const predictedVariance = variance + processNoise;
        const gain = predictedVariance / (predictedVariance + measurementNoise);
        const filtered = estimate + gain * (measurement - estimate);
        return Object.freeze({ measurement, estimate: filtered, variance: (1 - gain) * predictedVariance, gain });
    };
    const getRunLength = (values) => {
        if (!Array.isArray(values) || values.length === 0) return 0;
        const last = values[values.length - 1];
        let length = 0;
        for (let index = values.length - 1; index >= 0 && values[index] === last; index--) length++;
        return length;
    };
    const getRoadRegime = (history, previousEntropy = null) => {
        try {
            const outcomes = Array.isArray(history) ? history.filter(validOutcome) : [];
            const directional = outcomes.filter(outcome => outcome === '莊' || outcome === '閒');
            const recent = directional.slice(-ULTIMATE_CONFIG.ENTROPY_WINDOW);
            const entropyState = kalmanFilterEntropy(outcomes, previousEntropy);
            const runLength = getRunLength(recent);
            const switches = recent.slice(1).filter((outcome, index) => outcome !== recent[index]).length;
            const alternationRatio = recent.length > 1 ? switches / (recent.length - 1) : 0;
            const longTrend = runLength >= ULTIMATE_CONFIG.LONG_TREND_MIN_RUN;
            const stableAlternation = recent.length >= ULTIMATE_CONFIG.STABLE_ALTERNATION_MIN_ROUNDS && alternationRatio >= ULTIMATE_CONFIG.STABLE_ALTERNATION_RATIO;
            const regime = longTrend ? '長龍趨勢' : stableAlternation ? '穩定單跳' : entropyState.estimate >= ULTIMATE_CONFIG.RANDOM_ENTROPY_THRESHOLD ? '隨機震盪' : '過渡觀察';
            return Object.freeze({
                regime,
                entropy: entropyState.estimate,
                entropyMeasurement: entropyState.measurement,
                entropyVariance: entropyState.variance,
                runLength,
                runDirection: longTrend ? recent[recent.length - 1] : null,
                alternationRatio,
                exception: longTrend || stableAlternation
            });
        } catch (_) {
            return Object.freeze({ regime: '過渡觀察', entropy: 0, entropyMeasurement: 0, entropyVariance: 1, runLength: 0, runDirection: null, alternationRatio: 0, exception: false });
        }
    };
    const calculateDynamicKelly = (winProbability, confidence, odds = 1, fraction = ULTIMATE_CONFIG.KELLY_FRACTION, cap = ULTIMATE_CONFIG.KELLY_CAP) => {
        const probability = Math.min(1, Math.max(0, Number(winProbability) || 0));
        const safeOdds = Math.max(0.0001, Number(odds) || 1);
        const safeConfidence = Math.min(1, Math.max(0, Number(confidence) || 0));
        const rawKelly = (probability * safeOdds - (1 - probability)) / safeOdds;
        const stakeFraction = Math.min(Math.max(0, Number(cap) || 0), Math.max(0, rawKelly) * safeConfidence * Math.min(1, Math.max(0, Number(fraction) || 0)));
        return Object.freeze({ probability, confidence: safeConfidence, rawKelly, stakeFraction, capped: stakeFraction >= cap });
    };
    const estimateRemainingShoe = (history) => {
        try {
            const values = Array.isArray(history) ? history.filter(validOutcome) : [];
            const counts = values.reduce((result, outcome) => { result[outcome]++; return result; }, { '莊': 0, '閒': 0, '和': 0 });
            const total = values.length;
            const directionalTotal = counts['莊'] + counts['閒'];
            const bankerRate = directionalTotal > 0 ? counts['莊'] / directionalTotal : 0.5;
            const playerRate = directionalTotal > 0 ? counts['閒'] / directionalTotal : 0.5;
            const active = total >= ULTIMATE_CONFIG.SHOE_MIN_ROUNDS;
            const deviation = bankerRate - BACCARAT_PRIOR_BANKER_RATE;
            const strength = active ? Math.min(1, (total - ULTIMATE_CONFIG.SHOE_MIN_ROUNDS + 1) / ULTIMATE_CONFIG.MAX_HISTORY) : 0;
            return Object.freeze({ total, counts, bankerRate, playerRate, tieRate: total > 0 ? counts['和'] / total : 0, deviation, strength, active });
        } catch (_) {
            return Object.freeze({ total: 0, counts: { '莊': 0, '閒': 0, '和': 0 }, bankerRate: 0.5, playerRate: 0.5, tieRate: 0, deviation: 0, strength: 0, active: false });
        }
    };
    const getMultiTimeframeProfile = (history) => {
        try {
            const values = Array.isArray(history) ? history.filter(validOutcome) : [];
            const distribution = (window) => {
                const sample = values.slice(-window);
                const counts = sample.reduce((result, outcome) => { result[outcome]++; return result; }, { '莊': 0, '閒': 0, '和': 0 });
                const total = sample.length + 3;
                // 以理論基準作為 3 個虛擬樣本的分配比例，而非每類各 1 個。
                return { '莊': (counts['莊'] + 3 * BACCARAT_PRIOR['莊']) / total, '閒': (counts['閒'] + 3 * BACCARAT_PRIOR['閒']) / total, '和': (counts['和'] + 3 * BACCARAT_PRIOR['和']) / total, samples: sample.length };
            };
            const short = distribution(ULTIMATE_CONFIG.SHORT_WINDOW);
            const medium = distribution(ULTIMATE_CONFIG.MEDIUM_WINDOW);
            const long = distribution(Math.max(ULTIMATE_CONFIG.MEDIUM_WINDOW, values.length));
            const usable = [short, medium, long].filter(item => item.samples > 0);
            const agreement = usable.length > 0 ? usable.filter(item => (item['莊'] >= item['閒']) === (medium['莊'] >= medium['閒'])).length / usable.length : 0;
            return Object.freeze({ short, medium, long, agreement, usableWindows: usable.length });
        } catch (_) {
            const neutral = { ...BACCARAT_PRIOR, samples: 0 };
            return Object.freeze({ short: neutral, medium: neutral, long: neutral, agreement: 0, usableWindows: 0 });
        }
    };
    const applyPredictiveAdjustments = (baseDistribution, shoe, timeframe) => {
        const normalize = (probabilities) => {
            const total = ['莊', '閒', '和'].reduce((sum, outcome) => sum + Math.max(0, Number(probabilities[outcome]) || 0), 0);
            if (!Number.isFinite(total) || total <= 0) return { ...BACCARAT_PRIOR };
            return { '莊': Math.max(0, Number(probabilities['莊']) || 0) / total, '閒': Math.max(0, Number(probabilities['閒']) || 0) / total, '和': Math.max(0, Number(probabilities['和']) || 0) / total };
        };
        const base = normalize(baseDistribution || {});
        const estimate = shoe && shoe.active ? shoe : estimateRemainingShoe([]);
        const correction = Math.min(ULTIMATE_CONFIG.SHOE_BIAS_CAP, Math.abs(estimate.deviation) * estimate.strength);
        const adjusted = { ...base };
        if (correction > 0) {
            if (estimate.deviation > 0) { adjusted['莊'] *= 1 - correction; adjusted['閒'] *= 1 + correction; }
            else { adjusted['莊'] *= 1 + correction; adjusted['閒'] *= 1 - correction; }
        }
        const profile = timeframe || getMultiTimeframeProfile([]);
        const windowWeight = Math.min(0.25, Math.max(0, profile.agreement * 0.25));
        adjusted['莊'] = adjusted['莊'] * (1 - windowWeight) + profile.medium['莊'] * windowWeight;
        adjusted['閒'] = adjusted['閒'] * (1 - windowWeight) + profile.medium['閒'] * windowWeight;
        adjusted['和'] = adjusted['和'] * (1 - windowWeight) + profile.medium['和'] * windowWeight;
        return normalize(adjusted);
    };
    const getRoadConsensus = (models, regime) => {
        try {
            const groups = [
                ['大路', /^(frequency|weighted|exponential)/],
                ['大眼路', /^(markov|directionalMarkov)/],
                ['小路', /^(pattern|run)/],
                ['曱甴路', /^(alternation|transition)/]
            ];
            const votes = groups.map(([road, matcher]) => {
                const entries = models.filter(entry => matcher.test(entry.key) && entry.distribution);
                const score = entries.reduce((result, entry) => {
                    result['莊'] += entry.distribution['莊'];
                    result['閒'] += entry.distribution['閒'];
                    return result;
                }, { '莊': 0, '閒': 0 });
                const target = score['莊'] === score['閒'] ? null : score['莊'] > score['閒'] ? '莊' : '閒';
                return { road, target, sampleCount: entries.length };
            });
            const counts = votes.reduce((result, vote) => {
                if (vote.target) result[vote.target]++;
                return result;
            }, { '莊': 0, '閒': 0 });
            const target = counts['莊'] === counts['閒'] ? null : counts['莊'] > counts['閒'] ? '莊' : '閒';
            return Object.freeze({ votes, target, agreement: target ? counts[target] / votes.filter(vote => vote.target).length : 0, count: target ? counts[target] : 0, exception: Boolean(regime && regime.exception) });
        } catch (_) {
            return Object.freeze({ votes: [], target: null, agreement: 0, count: 0, exception: false });
        }
    };
    const martingaleStake = (base, losses = 0, cap = Number.MAX_SAFE_INTEGER) => {
        const unit = assertFiniteNonNegative(base, '基礎注碼');
        const count = assertFiniteNonNegative(losses, '連敗次數');
        const limit = assertFiniteNonNegative(cap, '注碼上限');
        if (!Number.isInteger(count)) throw new TypeError('連敗次數必須是整數');
        if (unit === 0 || limit === 0) return 0;
        if (Math.log(unit) + (count * Math.LN2) >= Math.log(limit)) return limit;
        return Math.min(limit, unit * (2 ** count));
    };
    const fibonacciStake = (base, losses = 0, cap = Number.MAX_SAFE_INTEGER) => {
        const unit = assertFiniteNonNegative(base, '基礎注碼');
        const count = assertFiniteNonNegative(losses, '連敗次數');
        const limit = assertFiniteNonNegative(cap, '注碼上限');
        if (!Number.isInteger(count)) throw new TypeError('連敗次數必須是整數');
        if (unit === 0) return 0;
        let a = 1, b = 1;
        for (let index = 0; index < count; index++) {
            if (a > limit / unit) return limit;
            [a, b] = [b, a + b];
        }
        return Math.min(limit, unit * a);
    };
    const strategyFunctions = Object.freeze({ martingale: martingaleStake, fibonacci: fibonacciStake });
    const validateLossStreak = (lossStreak) => {
        const count = assertFiniteNonNegative(lossStreak, '連敗次數');
        if (!Number.isInteger(count)) throw new TypeError('連敗次數必須是整數');
        return count;
    };
    const getRiskControlledStake = (strategy, base, lossStreak = 0, cap = Number.MAX_SAFE_INTEGER, maxLossStreak = DEFAULT_MAX_LOSS_STREAK) => {
        if (!Object.prototype.hasOwnProperty.call(strategyFunctions, strategy)) throw new RangeError('不支援的注碼策略');
        const count = validateLossStreak(lossStreak);
        const stopLoss = validateLossStreak(maxLossStreak);
        if (stopLoss < 1) throw new RangeError('止損連敗次數必須大於 0');
        assertFiniteNonNegative(base, '基礎注碼');
        assertFiniteNonNegative(cap, '注碼上限');
        if (count >= stopLoss) {
            return Object.freeze({ strategy, stake: 0, lossStreak: count, stopped: true, resetRequired: true, reason: '達到連敗止損線，必須重設策略' });
        }
        return Object.freeze({
            strategy,
            stake: strategyFunctions[strategy](base, count, cap),
            lossStreak: count,
            stopped: false,
            resetRequired: false,
            reason: null
        });
    };
    const advanceRiskState = (strategy, state = {}, outcome, options = {}) => {
        if (!state || typeof state !== 'object') throw new TypeError('風控狀態必須是物件');
        if (!['win', 'loss', 'push', 'reset'].includes(outcome)) throw new RangeError('結果必須是 win、loss、push 或 reset');
        const previousLosses = validateLossStreak(state.lossStreak || 0);
        const maxLossStreak = options.maxLossStreak ?? DEFAULT_MAX_LOSS_STREAK;
        const nextLosses = outcome === 'loss' ? previousLosses + 1 : 0;
        const plan = getRiskControlledStake(strategy, options.base, nextLosses, options.cap, maxLossStreak);
        return Object.freeze({ ...plan, outcome, previousLossStreak: previousLosses });
    };
    let modelPerformance = Object.create(null);

    // 【修正：對齊觀望局數與訊號門檻】MIN_SIGNAL_HISTORY 原設為 6，但 OBSERVATION_ROUNDS
    // （觀望局數）僅為 3，兩者不一致會導致「觀望三局後推薦方向雖已亮起，卻因歷史資料
    // 未達 6 局而 isReal 仍為 false」，使自動下注被靜默延後到第 6 局以後才真正觸發，
    // 造成使用者體感上的「推薦方向出現後過幾局才下注」的延遲。現改為與 OBSERVATION_ROUNDS
    // 一致，讓觀望期一結束、只要其餘信心條件（margin/agreement）同時達標，即可立即視為
    // 有效訊號並同步下注，不再有這道獨立於觀望設定之外的隱藏延遲門檻。
    const PREDICTION_CONFIG = Object.freeze({ MIN_HISTORY: 1, MIN_SIGNAL_HISTORY: ULTIMATE_CONFIG.OBSERVATION_ROUNDS, MIN_MARGIN: 0.02, MIN_AGREEMENT: 0.5, SMOOTHING_ALPHA: 1 });
    const MODEL_COUNT = 60;
    const MODEL_BASE_WEIGHT = 1 / MODEL_COUNT;
    function createPriorDistribution() { return { ...BACCARAT_PRIOR }; }
    function normalizeDistribution(probabilities) {
        const outcomes = ['莊', '閒', '和'];
        const total = outcomes.reduce((sum, outcome) => sum + Number(probabilities[outcome] || 0), 0);
        if (!Number.isFinite(total) || total <= 0) return createPriorDistribution();
        return outcomes.reduce((result, outcome) => {
            result[outcome] = Math.max(0, Number(probabilities[outcome] || 0)) / total;
            return result;
        }, {});
    }
    // Laplace 平滑：總虛擬樣本數維持 3α，但依理論基準分配到莊／閒／和，而非每類各 α。
    // 樣本不足時模型會自然回到「莊略優、和局少見」的真實基準，而不是回到不存在的三等分世界。
    function distributionFromCounts(counts, alpha = PREDICTION_CONFIG.SMOOTHING_ALPHA) {
        const pseudo = alpha * 3;
        const total = ['莊', '閒', '和'].reduce((sum, outcome) => sum + (counts[outcome] || 0), 0) + pseudo;
        return {
            '莊': ((counts['莊'] || 0) + pseudo * BACCARAT_PRIOR['莊']) / total,
            '閒': ((counts['閒'] || 0) + pseudo * BACCARAT_PRIOR['閒']) / total,
            '和': ((counts['和'] || 0) + pseudo * BACCARAT_PRIOR['和']) / total
        };
    }
    function getObservedOutcomes(sequence) {
        return sequence.filter(outcome => outcome === '莊' || outcome === '閒' || outcome === '和');
    }
    function createBootstrapSequence(bankerCount, playerCount, tieCount) {
        const sequence = [];
        const total = bankerCount + playerCount + tieCount;
        if (total <= 0) return sequence;
        const scale = Math.max(1, Math.ceil(total / 48));
        for (let index = 0; index < Math.ceil(bankerCount / scale); index++) sequence.push('莊');
        for (let index = 0; index < Math.ceil(playerCount / scale); index++) sequence.push('閒');
        for (let index = 0; index < Math.ceil(tieCount / scale); index++) sequence.push('和');
        return sequence.slice(-48);
    }
    function getFrequencyModel(outcomes) { const counts = { '莊': 0, '閒': 0, '和': 0 }; outcomes.forEach(outcome => { counts[outcome]++; }); return distributionFromCounts(counts); }
    function getRecentFrequencyModel(outcomes) { return getFrequencyModel(outcomes.slice(-12)); }
    function getWeightedFrequencyModel(outcomes, windowSize) {
        const counts = { '莊': 0, '閒': 0, '和': 0 };
        const recent = outcomes.slice(-windowSize);
        recent.forEach((outcome, index) => { counts[outcome] += index + 1; });
        return distributionFromCounts(counts);
    }
    function getExponentialFrequencyModel(outcomes, decay = 0.85, windowSize = 24) {
        const counts = { '莊': 0, '閒': 0, '和': 0 };
        outcomes.slice(-windowSize).forEach((outcome, index, recent) => { counts[outcome] += Math.pow(decay, recent.length - index - 1); });
        return distributionFromCounts(counts);
    }
    function getConditionalTransitionModel(outcomes, trigger) {
        if (outcomes.length < 3) return null;
        const counts = { '莊': 0, '閒': 0, '和': 0 };
        for (let index = 1; index < outcomes.length; index++) {
            if (outcomes[index - 1] === trigger) counts[outcomes[index]]++;
        }
        return counts['莊'] + counts['閒'] + counts['和'] >= 2 ? distributionFromCounts(counts) : null;
    }
    function getSequenceTransitionModel(outcomes, triggerSequence) {
        if (outcomes.length <= triggerSequence.length) return null;
        const counts = { '莊': 0, '閒': 0, '和': 0 };
        for (let index = triggerSequence.length; index < outcomes.length; index++) {
            if (outcomes.slice(index - triggerSequence.length, index).join('|') === triggerSequence.join('|')) counts[outcomes[index]]++;
        }
        return counts['莊'] + counts['閒'] + counts['和'] >= 2 ? distributionFromCounts(counts) : null;
    }
    function getRunLengthModel(outcomes) {
        const nonTie = outcomes.filter(outcome => outcome === '莊' || outcome === '閒');
        if (nonTie.length < 4) return null;
        const last = nonTie[nonTie.length - 1], currentLength = nonTie.reduce((length, outcome) => outcome === last ? length + 1 : 0, 0);
        const counts = { '莊': 0, '閒': 0, '和': 0 };
        for (let index = 1; index < nonTie.length; index++) {
            let length = 1;
            for (let cursor = index - 1; cursor > 0 && nonTie[cursor] === nonTie[cursor - 1]; cursor--) length++;
            if (length === currentLength && nonTie[index] !== nonTie[index - 1]) counts[nonTie[index]]++;
        }
        return counts['莊'] + counts['閒'] >= 2 ? distributionFromCounts(counts) : null;
    }
    function getMarkovModel(outcomes, order) {
        if (outcomes.length <= order) return null;
        const currentState = outcomes.slice(-order).join('|'); const counts = { '莊': 0, '閒': 0, '和': 0 };
        for (let index = order; index < outcomes.length; index++) { const state = outcomes.slice(index - order, index).join('|'); if (state === currentState) counts[outcomes[index]]++; }
        const stateCount = counts['莊'] + counts['閒'] + counts['和']; return stateCount >= 2 ? distributionFromCounts(counts) : null;
    }
    function getPatternModel(outcomes, patternLength = 2) {
        const nonTie = outcomes.filter(outcome => outcome === '莊' || outcome === '閒');
        if (nonTie.length < patternLength) return null;
        const pattern = nonTie.slice(-patternLength).join('|'), counts = { '莊': 0, '閒': 0, '和': 0 };
        for (let index = patternLength; index < nonTie.length; index++) {
            if (nonTie.slice(index - patternLength, index).join('|') === pattern) counts[nonTie[index]]++;
        }
        return counts['莊'] + counts['閒'] >= 2 ? distributionFromCounts(counts) : null;
    }
    function getRunModel(outcomes, runLength) {
        const nonTie = outcomes.filter(outcome => outcome === '莊' || outcome === '閒');
        if (nonTie.length < runLength) return null;
        const last = nonTie[nonTie.length - 1], counts = { '莊': 0, '閒': 0, '和': 0 };
        let currentRun = 0;
        for (let index = nonTie.length - 1; index >= 0 && nonTie[index] === last; index--) currentRun++;
        if (currentRun < runLength) return null;
        for (let index = 1; index < nonTie.length; index++) {
            let previousRun = 1;
            for (let cursor = index - 1; cursor > 0 && nonTie[cursor] === nonTie[cursor - 1]; cursor--) previousRun++;
            if (previousRun >= runLength && nonTie[index] !== nonTie[index - 1]) counts[nonTie[index]]++;
        }
        return counts['莊'] + counts['閒'] >= 2 ? distributionFromCounts(counts) : null;
    }
    function getAlternationModel(outcomes, windowSize) {
        const nonTie = outcomes.filter(outcome => outcome === '莊' || outcome === '閒').slice(-(windowSize + 1));
        if (nonTie.length < 3) return null;
        let alternations = 0;
        for (let index = 1; index < nonTie.length; index++) if (nonTie[index] !== nonTie[index - 1]) alternations++;
        const last = nonTie[nonTie.length - 1], counts = { '莊': 1, '閒': 1, '和': 1 };
        counts[alternations / (nonTie.length - 1) >= 0.5 ? (last === '莊' ? '閒' : '莊') : last] += 1;
        return distributionFromCounts(counts);
    }
    function getRoadInquiryModel(outcomes) {
        try {
            const inquiry = simulateRoadInquiry(outcomes);
            if (!inquiry || (!inquiry.threeRedsTarget && !inquiry.preference)) return null;
            const counts = { '莊': 1, '閒': 1, '和': 1 };
            if (inquiry.threeRedsTarget) {
                counts[inquiry.threeRedsTarget] += 4;
            } else if (inquiry.preference && inquiry.differential > 0) {
                counts[inquiry.preference] += inquiry.differential >= 2 ? 3 : 2;
            }
            return counts['莊'] !== counts['閒'] ? distributionFromCounts(counts) : null;
        } catch (error) {
            return null;
        }
    }
    function getRoadPatternModel(outcomes) {
        try {
            const analysis = analyzeRoadPatterns(outcomes);
            if (!analysis || !analysis.target) return null;
            const counts = { '莊': 1, '閒': 1, '和': 1 };
            const boost = Math.round((analysis.confidence || 0.5) * 4);
            counts[analysis.target] += Math.max(1, boost);
            return counts['莊'] !== counts['閒'] ? distributionFromCounts(counts) : null;
        } catch (error) {
            return null;
        }
    }
    function getDerivedTrendModel(outcomes) {
        try {
            const roads = analyzeRoads(outcomes);
            const derivedList = [roads['大眼路'], roads['小路'], roads['曱甴路']].filter(Array.isArray);
            let totalRed = 0, totalBlue = 0;
            derivedList.forEach(road => {
                road.forEach(cell => {
                    if (cell.color === '紅') totalRed++;
                    else if (cell.color === '藍') totalBlue++;
                });
            });
            if (totalRed + totalBlue < 4) return null;
            const inquiry = simulateRoadInquiry(outcomes);
            if (!inquiry) return null;
            const counts = { '莊': 1, '閒': 1, '和': 1 };
            const preferRed = totalRed >= totalBlue;
            const bankerScore = preferRed ? inquiry.bankerReds : (3 - inquiry.bankerReds);
            const playerScore = preferRed ? inquiry.playerReds : (3 - inquiry.playerReds);
            if (bankerScore > playerScore) counts['莊'] += (bankerScore - playerScore) * 2;
            else if (playerScore > bankerScore) counts['閒'] += (playerScore - bankerScore) * 2;
            return counts['莊'] !== counts['閒'] ? distributionFromCounts(counts) : null;
        } catch (error) {
            return null;
        }
    }
    function getBigRoadSymmetryModel(outcomes) {
        try {
            const bigRoad = analyzeRoads(outcomes)['大路'];
            if (!Array.isArray(bigRoad) || bigRoad.length < 3) return null;
            const validCols = bigRoad.filter(col => col.length > 0 && (col[0].outcome === '莊' || col[0].outcome === '閒'));
            if (validCols.length < 3) return null;
            const recentCols = validCols.slice(-4);
            const currentCol = recentCols[recentCols.length - 1];
            const prevCol = recentCols[recentCols.length - 2];
            const currentOutcome = currentCol[0].outcome;
            const oppositeOutcome = currentOutcome === '莊' ? '閒' : '莊';
            const currentHeight = currentCol.length;
            const prevHeight = prevCol.length;
            const counts = { '莊': 1, '閒': 1, '和': 1 };
            if (prevHeight >= 2 && currentHeight < prevHeight) {
                counts[currentOutcome] += 3;
            } else if (currentHeight >= prevHeight && currentHeight >= 2) {
                counts[oppositeOutcome] += 2;
            } else if (recentCols.every(c => c.length === 1)) {
                counts[oppositeOutcome] += 3;
            }
            return counts['莊'] !== counts['閒'] ? distributionFromCounts(counts) : null;
        } catch (error) {
            return null;
        }
    }
    // ============================================================================
    // 【3.0.0 動態馬可夫狀態矩陣 Dynamic Markov State Matrix】
    // 舊版以寫死的幾何規則辨識「大路雙跳、一廳兩房、逢莊跳、拍拍黐」等格局，無法反映
    // 「這一靴牌」的實際轉移特性。這裡改為直接統計當前靴牌中「最近 k 手狀態 → 下一手」的
    // 二階／三階經驗轉移機率，讓每一靴自己說話：
    //   - 珠盤路狀態：含和局的原始開出序列（bead）
    //   - 大路序列狀態：排除和局後的莊閒序列（sequence）
    //   - 大路結構狀態：以「前幾列高度 + 當前列高度」描述大路幾何，並記錄下一手是續出本列
    //     還是切換新列；單跳、雙跳、一廳兩房、拍拍黐都會自然落在不同狀態鍵上，不需寫死規則。
    // 每個狀態都會回傳 Laplace 平滑後的偏向勝率（edge）與樣本數；只有 edge 達到
    // MARKOV_STATE_EDGE_THRESHOLD（預設 52%）且樣本足夠時，才視為顯著規律並提高投票權重。
    // 注意：這是對「當前靴牌」的經驗統計，不是對下一局結果的保證。
    // ============================================================================
    const DYNAMIC_STATE_HEIGHT_CAP = 4;
    // 只統計「當前靴牌」附近的序列：一靴約 60～80 手，160 手約涵蓋兩靴，
    // 既保留足夠樣本，也避免把數百局前、早已無關的轉移特性帶進來，並讓計算量有上界。
    const DYNAMIC_STATE_LOOKBACK = 160;

    function summarizeDirectionalCounts(counts) {
        const banker = Number(counts && counts['莊']) || 0;
        const player = Number(counts && counts['閒']) || 0;
        const samples = banker + player;
        const bankerRate = (banker + 1) / (samples + 2);
        const target = samples === 0 || banker === player ? null : banker > player ? '莊' : '閒';
        return { samples, bankerRate, target, edge: Math.max(bankerRate, 1 - bankerRate) };
    }

    // 序列型狀態（珠盤路／大路序列）：最近 order 手的組合 → 下一手。以逐元素比對取代 slice/join，避免配置。
    function getSequenceStateTransition(symbols, order) {
        if (!Array.isArray(symbols) || !Number.isInteger(order) || order < 1) return null;
        const source = symbols.length > DYNAMIC_STATE_LOOKBACK ? symbols.slice(-DYNAMIC_STATE_LOOKBACK) : symbols;
        const length = source.length;
        if (length <= order) return null;
        const counts = { '莊': 0, '閒': 0, '和': 0 };
        const stateStart = length - order;
        for (let index = order; index < length; index++) {
            let matched = true;
            for (let offset = 0; offset < order; offset++) {
                if (source[index - order + offset] !== source[stateStart + offset]) { matched = false; break; }
            }
            if (!matched) continue;
            const next = source[index];
            if (counts[next] !== undefined) counts[next]++;
        }
        return { stateKey: source.slice(stateStart).join('|'), counts };
    }

    // 大路結構狀態：逐手重建大路，記錄「開出前的列高狀態」與「開出後是續出還是跳」。
    function getBigRoadStructureTransition(directionalOutcomes, order, includeColor) {
        if (!Array.isArray(directionalOutcomes) || !Number.isInteger(order) || order < 1) return null;
        const source = directionalOutcomes.length > DYNAMIC_STATE_LOOKBACK ? directionalOutcomes.slice(-DYNAMIC_STATE_LOOKBACK) : directionalOutcomes;
        if (source.length <= order) return null;
        const columns = [];
        const encode = () => {
            if (columns.length < order) return null;
            let key = includeColor ? columns[columns.length - 1].color + ':' : '';
            for (let index = columns.length - order; index < columns.length; index++) {
                key += (index > columns.length - order ? '-' : '') + Math.min(DYNAMIC_STATE_HEIGHT_CAP, columns[index].height);
            }
            return key;
        };
        const stateKeys = [];
        const nextMoves = [];
        for (let index = 0; index < source.length; index++) {
            const outcome = source[index];
            if (outcome !== '莊' && outcome !== '閒') continue;
            const last = columns[columns.length - 1];
            const key = encode();
            if (key && last) {
                stateKeys.push(key);
                nextMoves.push(outcome === last.color ? 'continue' : 'switch');
            }
            if (!last || last.color !== outcome) columns.push({ color: outcome, height: 1 }); else last.height++;
        }
        const currentKey = encode();
        const last = columns[columns.length - 1];
        if (!currentKey || !last) return null;
        let continueCount = 0;
        let switchCount = 0;
        for (let index = 0; index < stateKeys.length; index++) {
            if (stateKeys[index] !== currentKey) continue;
            if (nextMoves[index] === 'continue') continueCount++; else switchCount++;
        }
        const opposite = last.color === '莊' ? '閒' : '莊';
        const counts = { '莊': 0, '閒': 0, '和': 0 };
        counts[last.color] = continueCount;
        counts[opposite] = switchCount;
        return { stateKey: currentKey, counts, continueCount, switchCount, lastColor: last.color };
    }

    // Wilson score 區間下界：在有限樣本下估計「偏向勝率至少有多少」，比原始比例更保守。
    // z=1.0 約為單尾 84% 信賴水準；用它過濾掉 3/5、4/7 這類看似 ≥52% 其實毫無統計意義的狀態。
    function wilsonLowerBound(successes, samples, z = 1.0) {
        if (!Number.isFinite(successes) || !Number.isFinite(samples) || samples <= 0) return 0;
        const phat = successes / samples;
        const z2 = z * z;
        const denominator = 1 + z2 / samples;
        const centre = phat + z2 / (2 * samples);
        const spread = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * samples)) / samples);
        return Math.max(0, (centre - spread) / denominator);
    }

    function buildDynamicStateSignal(descriptor, transition) {
        if (!transition) return null;
        const summary = summarizeDirectionalCounts(transition.counts);
        const minSamples = ULTIMATE_CONFIG.MARKOV_STATE_MIN_SAMPLES;
        const majorityCount = summary.target ? Number(transition.counts[summary.target]) || 0 : 0;
        const lowerBound = summary.target ? wilsonLowerBound(majorityCount, summary.samples) : 0;
        // 「顯著規律」三條件：樣本夠、Laplace 平滑偏向 ≥ 門檻、且 Wilson 下界仍高於 50%（排除小樣本假象）。
        const significant = summary.samples >= minSamples
            && summary.target !== null
            && summary.edge >= ULTIMATE_CONFIG.MARKOV_STATE_EDGE_THRESHOLD
            && lowerBound > 0.5;
        // 權重加成：以 Wilson 下界超出 50% 的幅度計算（每 1% 約 +10%），上限由 MAX_BOOST 控制。
        const boost = significant ? Math.min(ULTIMATE_CONFIG.MARKOV_STATE_MAX_BOOST, (lowerBound - 0.5) * 10) : 0;
        return Object.freeze({
            ...descriptor,
            stateKey: transition.stateKey,
            counts: Object.freeze({ ...transition.counts }),
            samples: summary.samples,
            bankerRate: summary.bankerRate,
            edge: summary.edge,
            lowerBound,
            target: summary.target,
            significant,
            weightMultiplier: 1 + boost,
            distribution: summary.samples >= 2 ? distributionFromCounts(transition.counts) : null
        });
    }

    function getDynamicMarkovMatrix(outcomes, directionalOutcomes) {
        const empty = Object.freeze({ signals: [], significant: [], target: null, agreement: 0, bestEdge: 0, hasSignificantRegularity: false });
        try {
            const signals = [
                buildDynamicStateSignal({ key: 'bead2', road: '珠盤路', order: 2, modelKeys: ['markov2'] }, getSequenceStateTransition(outcomes, 2)),
                buildDynamicStateSignal({ key: 'bead3', road: '珠盤路', order: 3, modelKeys: ['markov3'] }, getSequenceStateTransition(outcomes, 3)),
                buildDynamicStateSignal({ key: 'sequence2', road: '大路序列', order: 2, modelKeys: ['directionalMarkov2', 'pattern2'] }, getSequenceStateTransition(directionalOutcomes, 2)),
                buildDynamicStateSignal({ key: 'sequence3', road: '大路序列', order: 3, modelKeys: ['directionalMarkov3', 'pattern3'] }, getSequenceStateTransition(directionalOutcomes, 3)),
                buildDynamicStateSignal({ key: 'sequence4', road: '大路序列', order: 4, modelKeys: ['directionalMarkov4', 'pattern4'] }, getSequenceStateTransition(directionalOutcomes, 4)),
                buildDynamicStateSignal({ key: 'structure2', road: '大路結構', order: 2, modelKeys: ['bigRoadMarkov2'] }, getBigRoadStructureTransition(directionalOutcomes, 2, false)),
                buildDynamicStateSignal({ key: 'structure3', road: '大路結構', order: 3, modelKeys: ['bigRoadMarkov3'] }, getBigRoadStructureTransition(directionalOutcomes, 3, false)),
                buildDynamicStateSignal({ key: 'structureColor2', road: '大路結構(含色)', order: 2, modelKeys: ['bigRoadColorMarkov2'] }, getBigRoadStructureTransition(directionalOutcomes, 2, true))
            ].filter(Boolean);
            const significant = signals.filter(signal => signal.significant);
            // 證據強度 = (edge - 0.5) × 樣本數：同時兼顧偏向幅度與樣本可信度。
            const score = significant.reduce((result, signal) => {
                result[signal.target] += (signal.edge - 0.5) * signal.samples;
                return result;
            }, { '莊': 0, '閒': 0 });
            const target = score['莊'] === score['閒'] ? null : score['莊'] > score['閒'] ? '莊' : '閒';
            const agreeing = target ? significant.filter(signal => signal.target === target).length : 0;
            const agreement = significant.length > 0 ? agreeing / significant.length : 0;
            return Object.freeze({
                signals,
                significant,
                target,
                agreement,
                bestEdge: significant.reduce((best, signal) => Math.max(best, signal.edge), 0),
                hasSignificantRegularity: target !== null && agreement >= ULTIMATE_CONFIG.MARKOV_STATE_MIN_AGREEMENT
            });
        } catch (error) {
            safeDebug('[MT Baccarat] 動態馬可夫矩陣略過異常資料', error);
            return empty;
        }
    }

    function getDynamicStateWeightMultiplier(key, matrix) {
        if (!matrix || !Array.isArray(matrix.signals)) return 1;
        const signal = matrix.signals.find(item => Array.isArray(item.modelKeys) && item.modelKeys.includes(key));
        return signal ? signal.weightMultiplier : 1;
    }

    // 以核心方向為基準，唯讀解析大眼路／小路／曱甴路是否形成強共振（≥2 條路同側且信心足夠）。
    // 供核心引擎的好路降載判定與輔助強化層共用，確保兩層看到的是同一份共振結果。
    function getDerivedRoadResonance(outcomes, referenceDirection) {
        try {
            if (referenceDirection !== '莊' && referenceDirection !== '閒') return null;
            const source = Array.isArray(outcomes) ? outcomes : [];
            // 只建立三條衍生路，不呼叫 analyzeRoads（後者會連帶重算問路與格局，成本高且此處用不到）。
            const roads = { '大眼路': buildDerivedRoad(source, 1), '小路': buildDerivedRoad(source, 2), '曱甴路': buildDerivedRoad(source, 3) };
            const roadBias = computeDerivedRoadBias(roads, referenceDirection);
            if (!roadBias) return null;
            const summaries = [roads['大眼路'], roads['小路'], roads['曱甴路']].map(summarizeDerivedRoad).filter(Boolean);
            if (summaries.length === 0) return null;
            const avgRedRatio = summaries.reduce((sum, item) => sum + item.redRatio, 0) / summaries.length;
            const continuation = avgRedRatio >= 0.5;
            const aligned = summaries.filter(item => (item.redRatio >= 0.5) === continuation).length;
            const confidence = Math.min(1, summaries.length / 3) * Math.min(1, Math.abs(avgRedRatio - 0.5) * 2);
            return Object.freeze({
                referenceDirection,
                roads,
                roadBias,
                target: continuation ? referenceDirection : (referenceDirection === '莊' ? '閒' : '莊'),
                avgRedRatio,
                alignedRoads: aligned,
                totalRoads: summaries.length,
                confidence,
                strong: summaries.length >= 2 && aligned >= 2 && confidence >= 0.4
            });
        } catch (error) {
            safeDebug('[MT Baccarat] 下三路共振解析略過', error);
            return null;
        }
    }

    function countSequenceMatches(outcomes, triggerSequence) {
        let matches = 0;
        for (let index = triggerSequence.length; index < outcomes.length; index++) {
            if (outcomes.slice(index - triggerSequence.length, index).join('|') === triggerSequence.join('|')) matches++;
        }
        return matches;
    }
    function getModelSampleCount(key, outcomes, directionalOutcomes) {
        if (/^bigRoad(?:Color)?Markov\d+$/.test(key)) {
            const order = Number(key.match(/(\d+)$/)[1]);
            const transition = getBigRoadStructureTransition(directionalOutcomes, order, key.startsWith('bigRoadColor'));
            return transition ? transition.counts['莊'] + transition.counts['閒'] : 0;
        }
        if (key === 'roadInquiry') return directionalOutcomes.length >= 6 ? Math.min(directionalOutcomes.length, 24) : 0;
        if (key === 'roadPattern') return directionalOutcomes.length >= 4 ? Math.min(directionalOutcomes.length, 20) : 0;
        if (key === 'derivedTrend') return directionalOutcomes.length >= 8 ? Math.min(directionalOutcomes.length, 30) : 0;
        if (key === 'bigRoadSymmetry') return directionalOutcomes.length >= 6 ? Math.min(directionalOutcomes.length, 18) : 0;
        const windowMatch = key.match(/(?:frequency|weighted)(\d+)/);
        if (windowMatch) return Math.min(outcomes.length, Number(windowMatch[1]));
        const exponentialMatch = key.match(/^exponential(\d+)$/);
        if (exponentialMatch) return Math.min(outcomes.length, Number(exponentialMatch[1]));
        const singleTransition = { transitionBanker: '莊', transitionPlayer: '閒', transitionTie: '和' };
        if (singleTransition[key]) {
            return outcomes.slice(0, -1).filter(outcome => outcome === singleTransition[key]).length;
        }
        const sequenceTransitions = {
            transitionBankerPlayer: ['莊', '閒'],
            transitionPlayerBanker: ['閒', '莊'],
            transitionSameDirection: ['莊', '莊'],
            transitionTieBanker: ['和', '莊']
        };
        if (sequenceTransitions[key]) return countSequenceMatches(outcomes, sequenceTransitions[key]);
        if (key === 'runLength') {
            const nonTie = directionalOutcomes;
            if (nonTie.length < 2) return 0;
            const last = nonTie[nonTie.length - 1];
            const currentLength = nonTie.reduce((length, outcome) => outcome === last ? length + 1 : 0, 0);
            let matches = 0;
            for (let index = 1; index < nonTie.length; index++) {
                let length = 1;
                for (let cursor = index - 1; cursor > 0 && nonTie[cursor] === nonTie[cursor - 1]; cursor--) length++;
                if (length === currentLength && nonTie[index] !== nonTie[index - 1]) matches++;
            }
            return matches;
        }
        const orderMatch = key.match(/(?:markov|pattern|run)(\d+)/);
        if (orderMatch) {
            const source = key.startsWith('directional') || key.startsWith('pattern') || key.startsWith('run') ? directionalOutcomes : outcomes;
            const order = Number(orderMatch[1]);
            if (key.startsWith('pattern')) return countSequenceMatches(source, source.slice(-order));
            if (key.startsWith('run')) {
                const last = source[source.length - 1];
                let currentRun = 0;
                for (let index = source.length - 1; index >= 0 && source[index] === last; index--) currentRun++;
                if (currentRun < order) return 0;
                let matches = 0;
                for (let index = 1; index < source.length; index++) {
                    let previousRun = 1;
                    for (let cursor = index - 1; cursor > 0 && source[cursor] === source[cursor - 1]; cursor--) previousRun++;
                    if (previousRun >= order && source[index] !== source[index - 1]) matches++;
                }
                return matches;
            }
            const currentState = source.slice(-order).join('|');
            return Array.from({ length: Math.max(0, source.length - order) }, (_, index) => index + order)
                .filter(index => source.slice(index - order, index).join('|') === currentState).length;
        }
        const alternationMatch = key.match(/^alternation(\d+)$/);
        if (alternationMatch) return Math.max(0, Math.min(directionalOutcomes.length, Number(alternationMatch[1]) + 1) - 1);
        return outcomes.length;
    }
    function getModelFormula(key) {
        if (key.startsWith('bigRoadColorMarkov')) return 'P(續出|列高狀態,列色) = (count(state→續出) + α) / (count(state) + 2α)';
        if (key.startsWith('bigRoadMarkov')) return 'P(續出|列高狀態) = (count(state→續出) + α) / (count(state) + 2α)';
        if (key === 'roadInquiry') return 'P(x|Inquiry) = 莊閒下三路紅藍問路投影加權';
        if (key === 'roadPattern') return 'P(x|RoadPattern) = 經典格局（長龍/單跳/兩房兩廳/拍拍黐）加權';
        if (key === 'derivedTrend') return 'P(x|DerivedTrend) = 下三路紅藍趨勢一致性加權';
        if (key === 'bigRoadSymmetry') return 'P(x|Symmetry) = 大路相鄰列高對稱與齊頭齊腳識別';
        if (key.startsWith('frequency')) return 'P(x) = (count_window(x) + α) / (N_window + 3α)';
        if (key.startsWith('weighted')) return 'P(x) = (Σ(index × I[outcome=x]) + α) / (Σindex + 3α)';
        if (key.startsWith('exponential')) return 'P(x) = (Σ(decay^(age) × I[outcome=x]) + α) / (Σdecay^(age) + 3α)';
        if (key.startsWith('directionalMarkov') || key.startsWith('markov')) return 'P(x|S) = (count(S→x) + α) / (count(S) + 3α)';
        if (key.startsWith('pattern')) return 'P(x|pattern) = (count(pattern→x) + α) / (count(pattern) + 3α)';
        if (key.startsWith('run')) return 'P(x|run_length) = (count(run_length→x) + α) / (count(run_length) + 3α)';
        if (key.startsWith('alternation')) return 'P(x) = (base_count(x) + signal(x) + α) / (N_base + signal_total + 3α)';
        if (key.startsWith('transition')) return 'P(x|trigger_sequence) = (count(trigger_sequence→x) + α) / (count(trigger_sequence) + 3α)';
        return 'P(x) = (count(x) + α) / (N + 3α)';
    }
    function getModelInputDescription(key) {
        if (key.startsWith('bigRoadColorMarkov')) return '大路最近幾列高度 + 當前列顏色的動態狀態轉移（逢莊跳／逢閒連等）';
        if (key.startsWith('bigRoadMarkov')) return '大路最近幾列高度的動態狀態轉移（單跳／雙跳／一廳兩房／拍拍黐等）';
        if (key === 'roadInquiry') return '下三路（大眼仔、小路、曱甴路）紅藍問路模擬';
        if (key === 'roadPattern') return '大路幾何格局識別（長龍/單雙跳/拍拍黐/逢莊閒跳）';
        if (key === 'derivedTrend') return '下三路整體紅藍連續走勢與好路順勢度';
        if (key === 'bigRoadSymmetry') return '大路相鄰列高度對稱與切換週期分析';
        if (key.startsWith('frequency')) return '最近指定窗口的莊／閒／和結果';
        if (key.startsWith('weighted')) return '最近指定窗口，越新的結果乘以更高線性權重';
        if (key.startsWith('exponential')) return '最近指定窗口，依指數衰減計算時間權重';
        if (key.startsWith('directionalMarkov')) return '只使用莊／閒序列的指定階 Markov 狀態';
        if (key.startsWith('markov')) return '包含和局的指定階 Markov 狀態';
        if (key.startsWith('pattern')) return '移除和局後的莊／閒指定長度模式';
        if (key.startsWith('run')) return '移除和局後的指定連續長度';
        if (key.startsWith('alternation')) return '最近指定窗口的莊閒交替比例';
        if (key.startsWith('transition')) return '指定上一局或連續狀態後的下一局分布';
        return '完整觀測序列';
    }
    function getModelCalculationDetails(key) {
        const windowMatch = key.match(/(?:frequency|weighted|exponential)(\d+)/);
        const orderMatch = key.match(/(?:markov|pattern|run)(\d+)/);
        const alternationMatch = key.match(/^alternation(\d+)$/);
        const details = {
            parameter: windowMatch ? `window=${windowMatch[1]}` : orderMatch ? `order=${orderMatch[1]}` : alternationMatch ? `window=${alternationMatch[1]}` : 'trigger sequence',
            smoothing: `Laplace smoothing α=${PREDICTION_CONFIG.SMOOTHING_ALPHA}`,
            minimumEvidence: 'Markov／模式／連段／轉移模型至少需要 2 次匹配樣本；不足時排除',
            probabilityOutput: '輸出莊、閒、和三類分布，三者總和=1',
            effectiveWeight: 'w = (1/60) × min(1, sampleCount/8) × similarityPenalty',
            similarityPenalty: '0.85～1.00，降低與其他模型分布過度相似的重複投票',
            finalEnsemble: 'P_final(x) = Σ[w_i × P_i(x)] / Σw_i，再套用歷史結果保守校準'
        };
        if (key === 'roadInquiry') details.matchRule = '模擬開莊/開閒後大眼、小路、曱甴路之紅藍三紅與差值權重';
        if (key === 'roadPattern') details.matchRule = '比對大路長龍、單跳、雙跳(2-2)、一房兩廳與拍拍黐跟齊形態';
        if (key === 'derivedTrend') details.matchRule = '統計下三路整體紅藍比例，配合問路投影計算順勢方向';
        if (key === 'bigRoadSymmetry') details.matchRule = '依據前列高度與當前列長度判斷續出或跳向對家';
        if (key.startsWith('bigRoad') && key.includes('Markov')) {
            details.parameter = `order=${key.match(/(\d+)$/)[1]}（列數）`;
            details.matchRule = '以「最近幾列高度（含當前列）」為狀態，統計本靴同狀態後下一手續出或跳的比例，再映射回莊／閒';
            details.dynamicWeight = '狀態偏向勝率 ≥ MARKOV_STATE_EDGE_THRESHOLD 且樣本足夠時，投票權重最多提高 100%';
        }
        if (key.startsWith('weighted')) details.weightRule = '窗口內第 i 個結果使用 i 的線性權重，越新權重越高';
        if (key.startsWith('exponential')) details.weightRule = '窗口內結果使用 decay^age 指數衰減，較新結果影響較大';
        if (key.startsWith('frequency')) details.weightRule = '窗口內每局使用相同權重 1';
        if (key.startsWith('markov') || key.startsWith('directionalMarkov')) details.matchRule = '以最後 order 局狀態尋找歷史相同狀態的下一局';
        if (key.startsWith('pattern')) details.matchRule = '移除和局後，以最後 patternLength 局莊閒模式尋找後續結果';
        if (key.startsWith('run')) details.matchRule = '以目前連續莊或閒的長度尋找歷史轉折結果';
        if (key.startsWith('alternation')) details.matchRule = '計算窗口內莊閒切換比例，達 50% 時提高反向候選';
        if (key.startsWith('transition')) details.matchRule = '尋找相同上一局或兩局觸發序列後的下一局結果';
        return details;
    }
    function getModelSimilarityPenalty(entry, entries) {
        const peers = entries.filter(peer => peer !== entry && peer.distribution);
        if (peers.length === 0) return 1;
        const averageDistance = peers.reduce((sum, peer) => {
            return sum + (Math.abs(entry.distribution['莊'] - peer.distribution['莊']) +
                Math.abs(entry.distribution['閒'] - peer.distribution['閒']) +
                Math.abs(entry.distribution['和'] - peer.distribution['和'])) / 2;
        }, 0) / peers.length;
        return 0.85 + Math.min(0.15, averageDistance);
    }
    function getEffectiveModelWeight(entry, entries = [entry]) {
        const roleMultiplier = 1;
        return entry.weight * roleMultiplier * Math.min(1, (entry.sampleCount || 0) / 8) * getModelSimilarityPenalty(entry, entries);
    }
    function getRegimeWeightMultiplier(key, directionalOutcomes) {
        try {
            if (typeof key !== 'string' || !Array.isArray(directionalOutcomes) || directionalOutcomes.length < 4) return 1;
            const recent = directionalOutcomes.slice(-6);
            const last = directionalOutcomes[directionalOutcomes.length - 1];
            if (!last || recent.length < 2) return 1;
            const switches = recent.slice(1).filter((outcome, index) => outcome !== recent[index]).length;
            let runLength = 1;
            for (let index = directionalOutcomes.length - 2; index >= 0 && directionalOutcomes[index] === last; index--) runLength++;
            const highAlternation = recent.length >= ULTIMATE_CONFIG.STABLE_ALTERNATION_MIN_ROUNDS && switches / (recent.length - 1) >= ULTIMATE_CONFIG.STABLE_ALTERNATION_RATIO;
            const possibleBreak = runLength >= ULTIMATE_CONFIG.LONG_TREND_MIN_RUN && recent[recent.length - 2] === last;
            if ((highAlternation && key.startsWith('alternation')) || (possibleBreak && (key.startsWith('run') || key.startsWith('transition')))) return 1.12;
            if ((highAlternation && key.startsWith('run')) || (possibleBreak && key.startsWith('frequency'))) return 0.92;
        } catch (error) {
            safeDebug('[MT Baccarat] regime 權重略過異常資料', error);
        }
        return 1;
    }
    function getSafeRoadSummary(history) {
        try {
            const roads = analyzeRoads(Array.isArray(history) ? history : []);
            return {
                big: Array.isArray(roads['大路']) ? roads['大路'].length : 0,
                bigEye: Array.isArray(roads['大眼路']) ? roads['大眼路'].length : 0,
                small: Array.isArray(roads['小路']) ? roads['小路'].length : 0,
                cockroach: Array.isArray(roads['曱甴路']) ? roads['曱甴路'].length : 0
            };
        } catch (error) {
            safeDebug('[MT Baccarat] 路單摘要略過異常資料', error);
            return { big: 0, bigEye: 0, small: 0, cockroach: 0 };
        }
    }
    function weightedAverageDistributions(entries) {
        if (entries.length === 0) return createPriorDistribution(); const result = { '莊': 0, '閒': 0, '和': 0 };
        const totalWeight = entries.reduce((sum, entry) => sum + getEffectiveModelWeight(entry, entries), 0);
        if (totalWeight === 0) return createPriorDistribution();
        entries.forEach(entry => { const weight = getEffectiveModelWeight(entry, entries); result['莊'] += entry.distribution['莊'] * weight; result['閒'] += entry.distribution['閒'] * weight; result['和'] += entry.distribution['和'] * weight; });
        return normalizeDistribution({ '莊': result['莊'] / totalWeight, '閒': result['閒'] / totalWeight, '和': result['和'] / totalWeight });
    }
    function calibrateProbabilities(probabilities, records) {
        const settled = Array.isArray(records) ? records.filter(record => record && (record.status === 'win' || record.status === 'loss')) : [];
        if (settled.length < 6) return probabilities;
        // 【3.0.0 修正懸崖效應】舊版在命中率一低於 50% 時，會把 strength 從 ~1 直接切換成 ≤0.2，
        // 等於把整個機率分布壓平成近似均勻分布，margin 瞬間歸零、真實訊號全部消失，
        // 這正是「面板長時間卡在觀望」的主因之一。現在改為對稱且有上限的收縮：
        // 只看近期窗口，表現低於 50% 時最多往「理論基準分布」收縮 20%，表現正常則不動。
        const recent = settled.slice(-ULTIMATE_CONFIG.MODEL_PERFORMANCE_WINDOW);
        const accuracy = recent.filter(record => record.status === 'win').length / recent.length;
        const shrink = accuracy < 0.5 ? Math.min(0.2, (0.5 - accuracy) * 0.4) : 0;
        if (shrink <= 0) return probabilities;
        const strength = 1 - shrink;
        const adjusted = {};
        ['莊', '閒', '和'].forEach(outcome => {
            adjusted[outcome] = (Number(probabilities[outcome]) || 0) * strength + BACCARAT_PRIOR[outcome] * (1 - strength);
        });
        return normalizeDistribution(adjusted);
    }
    function getConsecutiveRealDirection(records, target) { let streak = 0; for (let index = records.length - 1; index >= 0; index--) { const record = records[index]; if (!record.isReal || record.target !== target) break; streak++; } return streak; }
    function getDirectionalTarget(distribution) {
        if (distribution['莊'] === distribution['閒']) return null;
        return distribution['莊'] > distribution['閒'] ? '莊' : '閒';
    }

    // 【莊向偏好共用判斷】
    // 排除和局後，押莊的長期勝率為 50.68%、押閒為 49.32%，兩者結構性相差 1.36%。
    // 因此「推薦閒」必須有足夠強的證據才划算——當模型對閒的機率優勢不到
    // BANKER_TILT_MARGIN 時，視為證據不足以抵銷莊的結構性優勢，改推薦莊。
    //
    // 抽成共用函式的原因：方向會先後經過 getEnsemblePrediction()（核心引擎）與
    // applyAuxiliaryRoadEnhancement()（下三路輔助強化層）兩道關卡，而面板與自動下注
    // 實際採用的是後者的輸出。若只在核心引擎套用偏好，輔助層的「下三路共振」分支
    // 會把方向覆寫回閒，使偏好形同虛設。兩處共用同一套判斷才能保證口徑一致。
    //
    // 回傳：{ target: 實際建議方向, applied: 是否觸發修正, playerEdge: 閒相對莊的機率優勢 }
    function resolveBankerTilt(target, probabilities) {
        const fallback = { target, applied: false, playerEdge: 0 };
        if (target !== '閒' || !probabilities) { return fallback; }
        const tiltMargin = Number(ULTIMATE_CONFIG.BANKER_TILT_MARGIN);
        if (!Number.isFinite(tiltMargin) || tiltMargin <= 0) { return fallback; }
        const playerEdge = Number(probabilities['閒']) - Number(probabilities['莊']);
        if (!Number.isFinite(playerEdge)) { return fallback; }
        return playerEdge < tiltMargin
            ? { target: '莊', applied: true, playerEdge }
            : { target: '閒', applied: false, playerEdge };
    }
    function getAdaptiveModelWeight(key, baseWeight) {
        // 各模型的近期命中率高度相關，依 4～40 局短窗調整權重會把同一段噪音
        // 重複放大；固定權重的 walk-forward 回放反而較穩定。保留函式介面，
        // 讓既有 modelVotes / 表現記錄仍可追蹤，避免短期結果直接改寫預測分布。
        return baseWeight;
    }
    function updateModelPerformance(prediction, actualOutcome) {
        if (actualOutcome === '和' || !prediction || !Array.isArray(prediction.modelVotes)) return;
        prediction.modelVotes.forEach(vote => {
            if (!vote.target) return;
            if (!modelPerformance[vote.key]) modelPerformance[vote.key] = { wins: 0, losses: 0, recent: [] };
            const result = vote.target === actualOutcome ? 'win' : 'loss';
            if (result === 'win') modelPerformance[vote.key].wins++; else modelPerformance[vote.key].losses++;
            modelPerformance[vote.key].recent.push(result);
            if (modelPerformance[vote.key].recent.length > ULTIMATE_CONFIG.MODEL_PERFORMANCE_WINDOW) {
                modelPerformance[vote.key].recent.shift();
            }
        });
    }
    function getEnsemblePrediction(seq, records) {
        const outcomes = getObservedOutcomes(seq);
        if (outcomes.length < PREDICTION_CONFIG.MIN_HISTORY) return { target: null, mode: '資料收集中', isReal: false, probabilities: null, modelCount: 0 };
        const directionalOutcomes = outcomes.filter(outcome => outcome === '莊' || outcome === '閒');
        // 【3.0.0】動態馬可夫狀態矩陣先於模型建構計算，供權重加成、好路降載與診斷欄位共用。
        const markovMatrix = getDynamicMarkovMatrix(outcomes, directionalOutcomes);
        const dynamicEntry = key => {
            const signal = markovMatrix.signals.find(item => item.modelKeys.includes(key));
            return signal && signal.distribution
                ? { key, distribution: signal.distribution, weight: MODEL_BASE_WEIGHT, role: 'dynamic', sampleCount: signal.samples }
                : null;
        };
        const models = [
            { key: 'frequency1', distribution: getFrequencyModel(outcomes.slice(-1)), weight: MODEL_BASE_WEIGHT },
            { key: 'frequency2', distribution: getFrequencyModel(outcomes.slice(-2)), weight: MODEL_BASE_WEIGHT },
            { key: 'frequency3', distribution: getFrequencyModel(outcomes.slice(-3)), weight: MODEL_BASE_WEIGHT },
            { key: 'frequency5', distribution: getFrequencyModel(outcomes.slice(-5)), weight: MODEL_BASE_WEIGHT },
            { key: 'frequency6', distribution: getFrequencyModel(outcomes.slice(-6)), weight: MODEL_BASE_WEIGHT },
            { key: 'frequency8', distribution: getFrequencyModel(outcomes.slice(-8)), weight: MODEL_BASE_WEIGHT },
            { key: 'frequency12', distribution: getFrequencyModel(outcomes.slice(-12)), weight: MODEL_BASE_WEIGHT },
            { key: 'frequency16', distribution: getFrequencyModel(outcomes.slice(-16)), weight: MODEL_BASE_WEIGHT },
            { key: 'frequency24', distribution: getFrequencyModel(outcomes.slice(-24)), weight: MODEL_BASE_WEIGHT },
            { key: 'frequency32', distribution: getFrequencyModel(outcomes.slice(-32)), weight: MODEL_BASE_WEIGHT },
            { key: 'frequency48', distribution: getFrequencyModel(outcomes.slice(-48)), weight: MODEL_BASE_WEIGHT },
            { key: 'weighted2', distribution: getWeightedFrequencyModel(outcomes, 2), weight: MODEL_BASE_WEIGHT },
            { key: 'weighted3', distribution: getWeightedFrequencyModel(outcomes, 3), weight: MODEL_BASE_WEIGHT },
            { key: 'weighted4', distribution: getWeightedFrequencyModel(outcomes, 4), weight: MODEL_BASE_WEIGHT },
            { key: 'weighted5', distribution: getWeightedFrequencyModel(outcomes, 5), weight: MODEL_BASE_WEIGHT },
            { key: 'weighted6', distribution: getWeightedFrequencyModel(outcomes, 6), weight: MODEL_BASE_WEIGHT },
            { key: 'weighted8', distribution: getWeightedFrequencyModel(outcomes, 8), weight: MODEL_BASE_WEIGHT },
            { key: 'weighted12', distribution: getWeightedFrequencyModel(outcomes, 12), weight: MODEL_BASE_WEIGHT },
            { key: 'weighted16', distribution: getWeightedFrequencyModel(outcomes, 16), weight: MODEL_BASE_WEIGHT },
            { key: 'weighted24', distribution: getWeightedFrequencyModel(outcomes, 24), weight: MODEL_BASE_WEIGHT },
            { key: 'weighted48', distribution: getWeightedFrequencyModel(outcomes, 48), weight: MODEL_BASE_WEIGHT },
            { key: 'exponential24', distribution: getExponentialFrequencyModel(outcomes), weight: MODEL_BASE_WEIGHT, role: 'auxiliary' },
            { key: 'exponential12', distribution: getExponentialFrequencyModel(outcomes, 0.85, 12), weight: MODEL_BASE_WEIGHT, role: 'auxiliary' },
            { key: 'exponential36', distribution: getExponentialFrequencyModel(outcomes, 0.9, 36), weight: MODEL_BASE_WEIGHT, role: 'auxiliary' },
            { key: 'markov1', distribution: getMarkovModel(outcomes, 1), weight: MODEL_BASE_WEIGHT },
            { key: 'markov2', distribution: getMarkovModel(outcomes, 2), weight: MODEL_BASE_WEIGHT },
            { key: 'markov3', distribution: getMarkovModel(outcomes, 3), weight: MODEL_BASE_WEIGHT },
            { key: 'markov4', distribution: getMarkovModel(outcomes, 4), weight: MODEL_BASE_WEIGHT },
            { key: 'markov5', distribution: getMarkovModel(outcomes, 5), weight: MODEL_BASE_WEIGHT },
            { key: 'directionalMarkov1', distribution: getMarkovModel(directionalOutcomes, 1), weight: MODEL_BASE_WEIGHT },
            { key: 'directionalMarkov2', distribution: getMarkovModel(directionalOutcomes, 2), weight: MODEL_BASE_WEIGHT },
            { key: 'directionalMarkov3', distribution: getMarkovModel(directionalOutcomes, 3), weight: MODEL_BASE_WEIGHT },
            { key: 'directionalMarkov4', distribution: getMarkovModel(directionalOutcomes, 4), weight: MODEL_BASE_WEIGHT },
            { key: 'directionalMarkov5', distribution: getMarkovModel(directionalOutcomes, 5), weight: MODEL_BASE_WEIGHT },
            { key: 'pattern2', distribution: getPatternModel(directionalOutcomes, 2), weight: MODEL_BASE_WEIGHT },
            { key: 'pattern3', distribution: getPatternModel(directionalOutcomes, 3), weight: MODEL_BASE_WEIGHT },
            { key: 'pattern4', distribution: getPatternModel(directionalOutcomes, 4), weight: MODEL_BASE_WEIGHT },
            { key: 'pattern5', distribution: getPatternModel(directionalOutcomes, 5), weight: MODEL_BASE_WEIGHT },
            { key: 'pattern6', distribution: getPatternModel(directionalOutcomes, 6), weight: MODEL_BASE_WEIGHT },
            { key: 'pattern7', distribution: getPatternModel(directionalOutcomes, 7), weight: MODEL_BASE_WEIGHT },
            { key: 'run1', distribution: getRunModel(directionalOutcomes, 1), weight: MODEL_BASE_WEIGHT },
            { key: 'run2', distribution: getRunModel(directionalOutcomes, 2), weight: MODEL_BASE_WEIGHT },
            { key: 'run3', distribution: getRunModel(directionalOutcomes, 3), weight: MODEL_BASE_WEIGHT },
            { key: 'run4', distribution: getRunModel(directionalOutcomes, 4), weight: MODEL_BASE_WEIGHT },
            { key: 'run5', distribution: getRunModel(directionalOutcomes, 5), weight: MODEL_BASE_WEIGHT },
            { key: 'run6', distribution: getRunModel(directionalOutcomes, 6), weight: MODEL_BASE_WEIGHT },
            { key: 'alternation3', distribution: getAlternationModel(directionalOutcomes, 3), weight: MODEL_BASE_WEIGHT },
            { key: 'alternation4', distribution: getAlternationModel(directionalOutcomes, 4), weight: MODEL_BASE_WEIGHT },
            { key: 'alternation6', distribution: getAlternationModel(directionalOutcomes, 6), weight: MODEL_BASE_WEIGHT },
            { key: 'alternation8', distribution: getAlternationModel(directionalOutcomes, 8), weight: MODEL_BASE_WEIGHT },
            { key: 'alternation12', distribution: getAlternationModel(directionalOutcomes, 12), weight: MODEL_BASE_WEIGHT },
            { key: 'alternation16', distribution: getAlternationModel(directionalOutcomes, 16), weight: MODEL_BASE_WEIGHT },
            { key: 'transitionBanker', distribution: getConditionalTransitionModel(outcomes, '莊'), weight: MODEL_BASE_WEIGHT, role: 'auxiliary' },
            { key: 'transitionPlayer', distribution: getConditionalTransitionModel(outcomes, '閒'), weight: MODEL_BASE_WEIGHT, role: 'auxiliary' },
            { key: 'transitionTie', distribution: getConditionalTransitionModel(outcomes, '和'), weight: MODEL_BASE_WEIGHT, role: 'auxiliary' },
            { key: 'runLength', distribution: getRunLengthModel(outcomes), weight: MODEL_BASE_WEIGHT, role: 'auxiliary' },
            { key: 'transitionBankerPlayer', distribution: getSequenceTransitionModel(outcomes, ['莊', '閒']), weight: MODEL_BASE_WEIGHT, role: 'auxiliary' },
            { key: 'transitionPlayerBanker', distribution: getSequenceTransitionModel(outcomes, ['閒', '莊']), weight: MODEL_BASE_WEIGHT, role: 'auxiliary' },
            { key: 'transitionSameDirection', distribution: getSequenceTransitionModel(outcomes, ['莊', '莊']), weight: MODEL_BASE_WEIGHT, role: 'auxiliary' },
            { key: 'transitionTieBanker', distribution: getSequenceTransitionModel(outcomes, ['和', '莊']), weight: MODEL_BASE_WEIGHT, role: 'auxiliary' },
            { key: 'roadInquiry', distribution: getRoadInquiryModel(outcomes), weight: MODEL_BASE_WEIGHT * 1.15, role: 'road' },
            { key: 'roadPattern', distribution: getRoadPatternModel(outcomes), weight: MODEL_BASE_WEIGHT * 1.15, role: 'road' },
            { key: 'derivedTrend', distribution: getDerivedTrendModel(outcomes), weight: MODEL_BASE_WEIGHT * 1.1, role: 'road' },
            { key: 'bigRoadSymmetry', distribution: getBigRoadSymmetryModel(outcomes), weight: MODEL_BASE_WEIGHT * 1.1, role: 'road' },
            // 【3.0.0】大路結構動態狀態模型：以列高狀態 → 續出／跳 的本靴經驗轉移取代寫死的幾何格局。
            dynamicEntry('bigRoadMarkov2'),
            dynamicEntry('bigRoadMarkov3'),
            dynamicEntry('bigRoadColorMarkov2')
        ].filter(entry => entry && entry.distribution).map(entry => ({
            ...entry,
            sampleCount: Number.isInteger(entry.sampleCount) ? entry.sampleCount : getModelSampleCount(entry.key, outcomes, directionalOutcomes),
            weight: getAdaptiveModelWeight(entry.key, MODEL_BASE_WEIGHT),
            formula: getModelFormula(entry.key),
            inputDescription: getModelInputDescription(entry.key),
            calculationDetails: getModelCalculationDetails(entry.key)
        })).filter(entry => {
            const requiresEvidence = /markov|pattern|run|alternation|transition|road|derived|bigRoad/i.test(entry.key);
            return entry.sampleCount >= (requiresEvidence ? 2 : 1);
        }).map(entry => ({
            ...entry,
            // regime 權重 × 動態馬可夫狀態權重：本靴中該狀態轉移偏向 ≥ 52% 時，對應路型模型票數最多加倍。
            dynamicStateMultiplier: getDynamicStateWeightMultiplier(entry.key, markovMatrix),
            weight: entry.weight * getRegimeWeightMultiplier(entry.key, directionalOutcomes) * getDynamicStateWeightMultiplier(entry.key, markovMatrix)
        }));
        const rawProbabilities = calibrateProbabilities(weightedAverageDistributions(models), records);
        const shoeEstimate = estimateRemainingShoe(outcomes);
        const timeframe = getMultiTimeframeProfile(outcomes);
        const probabilities = applyPredictiveAdjustments(rawProbabilities, shoeEstimate, timeframe);
        const regime = getRoadRegime(outcomes);
        const roadConsensus = getRoadConsensus(models, regime);
        const inquiryResult = simulateRoadInquiry(outcomes);
        const patternsResult = analyzeRoadPatterns(outcomes);
        let target = getDirectionalTarget(probabilities);
        if (regime.exception && regime.runDirection) {
            // 明確長龍時尊重大路趨勢；此例外仍受有效方向與資料品質檢查保護。
            target = regime.runDirection;
        } else if (regime.regime === '穩定單跳' && directionalOutcomes.length > 0) {
            target = directionalOutcomes[directionalOutcomes.length - 1] === '莊' ? '閒' : '莊';
        } else if (patternsResult && patternsResult.target && patternsResult.confidence >= 0.85) {
            // 強烈格局（如 2-2 雙跳、連跳、拍拍黐）直接提供形態推薦
            target = patternsResult.target;
        } else if (inquiryResult && inquiryResult.threeRedsTarget) {
            // 三紅問路強訊號
            target = inquiryResult.threeRedsTarget;
        } else if (roadConsensus.target && roadConsensus.count >= 2) {
            target = roadConsensus.target;
        }
        if (!target) {
            return {
                target: null, mode: '暫無訊號', isReal: false, probabilities, modelCount: models.length,
                modelVotes: models.map(entry => ({
                    key: entry.key, target: getDirectionalTarget(entry.distribution), formula: entry.formula,
                    input: entry.inputDescription, sampleCount: entry.sampleCount,
                    baseWeight: MODEL_BASE_WEIGHT, effectiveWeight: getEffectiveModelWeight(entry, models),
                    similarityPenalty: getModelSimilarityPenalty(entry, models), details: entry.calculationDetails
                }))
            };
        }
        const other = target === '莊' ? '閒' : '莊';
        const margin = probabilities[target] - probabilities[other];
        const totalWeight = models.reduce((sum, entry) => sum + getEffectiveModelWeight(entry, models), 0);
        const agreement = totalWeight > 0 ? models.reduce((sum, entry) => sum + (getDirectionalTarget(entry.distribution) === target ? getEffectiveModelWeight(entry, models) : 0), 0) / totalWeight : 0;
        // 核心共識度只計入頻率／Markov／模式／連段／交替與動態狀態模型，排除 auxiliary 與 road 角色，
        // 避免路型模型既參與方向決定、又替自己背書。
        const coreModels = models.filter(entry => entry.role !== 'auxiliary' && entry.role !== 'road');
        const coreWeight = coreModels.reduce((sum, entry) => sum + getEffectiveModelWeight(entry, models), 0);
        const coreAgreement = coreWeight > 0
            ? coreModels.reduce((sum, entry) => sum + (getDirectionalTarget(entry.distribution) === target ? getEffectiveModelWeight(entry, models) : 0), 0) / coreWeight
            : 0;
        const sameDirectionStreak = getConsecutiveRealDirection(records, target);
        const hasEnoughSignalHistory = outcomes.length >= PREDICTION_CONFIG.MIN_SIGNAL_HISTORY;
        const settled = Array.isArray(records) ? records.filter(record => record && (record.status === 'win' || record.status === 'loss')) : [];
        const recentSettled = settled.slice(-ULTIMATE_CONFIG.ENTROPY_WINDOW);
        const recentWinRate = recentSettled.length ? recentSettled.filter(record => record.status === 'win').length / recentSettled.length : 0.5;

        // ── 好路偵測（三個獨立來源，任一成立即視為當前靴牌具有顯著統計規律）──
        // (a) 路型例外：長龍順勢或穩定單跳（regime）
        // (b) 動態馬可夫矩陣：本靴狀態轉移偏向 ≥ 52% 且與核心方向一致
        // (c) 下三路共振：大眼／小／曱甴路 ≥2 條同側、信心足夠且指向核心方向
        const isThreeRedsResonance = Boolean(inquiryResult && inquiryResult.threeRedsTarget && inquiryResult.threeRedsTarget === target);
        const isPatternResonance = Boolean(patternsResult && patternsResult.target === target && patternsResult.confidence >= 0.7);
        const roadResonance = isThreeRedsResonance || isPatternResonance;
        const roadException = (regime.exception && (regime.runDirection === target || regime.regime === '穩定單跳')) || (isThreeRedsResonance && isPatternResonance);
        const markovResonance = Boolean(markovMatrix.hasSignificantRegularity && markovMatrix.target === target);
        const derivedRoadResonance = getDerivedRoadResonance(outcomes, target);
        const derivedResonance = Boolean(derivedRoadResonance && derivedRoadResonance.strong && derivedRoadResonance.target === target);
        const goodRoad = roadException || markovResonance || derivedResonance || roadResonance;

        // ── 自適應動態門檻 ──
        // 常規：margin ≥ 4.2%、核心共識 ≥ 59%（基礎高標準）；好路：margin 降載至 2.5%（防卡閥門）。
        // 牌靴開局前 10 手資料稀薄，門檻乘上 SHOE_OPENING_MARGIN_MULTIPLIER；推薦閒時再加 EV 補償。
        const isShoeOpening = outcomes.length <= ULTIMATE_CONFIG.SHOE_OPENING_ROUNDS;
        const isShoeEnding = outcomes.length >= ULTIMATE_CONFIG.SHOE_ENDING_ROUNDS;
        const shoeOpeningMultiplier = isShoeOpening ? ULTIMATE_CONFIG.SHOE_OPENING_MARGIN_MULTIPLIER : 1.0;
        const playerEvBonus = target === '閒' ? ULTIMATE_CONFIG.PLAYER_EV_MARGIN_BONUS : 0;
        const adaptiveMargin = goodRoad ? ULTIMATE_CONFIG.REAL_SIGNAL_RELAXED_MARGIN : ULTIMATE_CONFIG.REAL_SIGNAL_BASE_MARGIN;
        const adaptiveAgreement = ULTIMATE_CONFIG.REAL_SIGNAL_CORE_AGREEMENT;
        const effectiveMarginThreshold = adaptiveMargin * shoeOpeningMultiplier + playerEvBonus;

        // 真實訊號必須由核心模型自身的證據撐起：方向機率高於和局、淨邊際達門檻、核心共識達標。
        // 路型／問路／下三路只能提供「降載」與「參考方向」，不能單獨把弱核心訊號標成真實訊號。
        const coreEvidence = probabilities[target] > probabilities['和']
            && margin >= effectiveMarginThreshold
            && coreAgreement >= adaptiveAgreement;
        const staleDirection = sameDirectionStreak >= ULTIMATE_CONFIG.STALE_DIRECTION_STREAK && margin < ULTIMATE_CONFIG.STALE_DIRECTION_MARGIN;
        let hasSignal = hasEnoughSignalHistory && coreEvidence && (!staleDirection || roadException || isThreeRedsResonance);

        // ── 資訊熵動態防禦與模型離散度防禦 ──
        // 近 20 局二元熵 ≥ 0.985 代表莊閒幾乎各半、序列缺乏可利用結構；若同時沒有任何好路共振，
        // 取消真實訊號。注意：只取消 isReal，仍保留灰色參考方向供面板顯示，避免整體覆蓋率崩跌。
        const binaryEntropy = calculateBinaryEntropy(outcomes.slice(-ULTIMATE_CONFIG.ENTROPY_WINDOW));
        const isHighEntropy = binaryEntropy >= ULTIMATE_CONFIG.HIGH_ENTROPY_THRESHOLD;
        const consensusDisagreement = calculateConsensusDisagreement(models);
        const isHighDisagreement = consensusDisagreement >= ULTIMATE_CONFIG.MAX_CONSENSUS_DISAGREEMENT;

        let defenseMode = null;
        if (isHighEntropy && !goodRoad) {
            defenseMode = '高熵防禦';
            hasSignal = false;
        } else if (isHighDisagreement && !goodRoad) {
            defenseMode = '分歧觀望';
            hasSignal = false;
        }
        const isRealSignal = hasSignal;

        const hasReferenceDirection = probabilities[target] >= probabilities['和'];
        const resonanceBonus = (isThreeRedsResonance ? 0.08 : 0) + (isPatternResonance ? 0.06 : 0) + (markovResonance ? Math.min(0.08, (markovMatrix.bestEdge - 0.5) * 0.8) : 0);
        const confidence = Math.min(1, Math.max(0, (agreement + roadConsensus.agreement) / 2 + margin + resonanceBonus));
        let kelly = calculateDynamicKelly(probabilities[target], confidence);
        if (isShoeEnding && kelly.stakeFraction > ULTIMATE_CONFIG.SHOE_ENDING_KELLY_CAP) {
            // 舊版對 kelly 物件直接做 Math.min 會得到 NaN；牌靴尾段應只壓低建議注碼比例，其餘欄位保留。
            kelly = Object.freeze({ ...kelly, stakeFraction: ULTIMATE_CONFIG.SHOE_ENDING_KELLY_CAP, capped: true });
        }

        // 模式文字：真實訊號時標示是哪一種證據撐起的；非真實訊號時，防禦模式優先，其次為參考方向。
        const realMode = roadException ? '順勢例外'
            : (isThreeRedsResonance && isPatternResonance) ? '牌路共振'
            : markovResonance ? '狀態矩陣共振'
            : derivedResonance ? '下三路共振'
            : '精算完成';
        const mode = isRealSignal ? realMode : defenseMode ? defenseMode : hasReferenceDirection ? '參考方向' : '暫無訊號';
        const rawFinalTarget = isRealSignal || hasReferenceDirection ? target : null;

        // 【莊向偏好】在方向確定後、回傳前套用，刻意不回頭改寫 margin / agreement / hasSignal，
        // 讓「模型原本怎麼想」（rawTarget）與「實際建議押哪邊」（target）保持可追溯、可稽核。
        const bankerTilt = resolveBankerTilt(rawFinalTarget, probabilities);
        const bankerTiltApplied = bankerTilt.applied;
        const finalTarget = bankerTilt.target;
        return {
            engineVersion: BACCARAT_API_VERSION,
            target: finalTarget,
            rawTarget: rawFinalTarget,
            bankerTiltApplied,
            playerEdge: bankerTilt.playerEdge,
            mode,
            defenseMode,
            isReal: isRealSignal, probabilities, modelCount: models.length, sameDirectionStreak,
            regime, roadConsensus, adaptiveMargin, adaptiveAgreement, effectiveMarginThreshold, margin, agreement, coreAgreement,
            goodRoad, markovResonance, derivedResonance, roadResonance, roadException,
            markovMatrix, derivedRoadResonance,
            recentWinRate, kelly, shoeEstimate, timeframe,
            binaryEntropy, consensusDisagreement,
            modelVotes: models.map(entry => ({
                key: entry.key,
                role: entry.role || 'core',
                target: getDirectionalTarget(entry.distribution),
                formula: entry.formula,
                input: entry.inputDescription,
                sampleCount: entry.sampleCount,
                baseWeight: MODEL_BASE_WEIGHT,
                dynamicStateMultiplier: entry.dynamicStateMultiplier || 1,
                effectiveWeight: getEffectiveModelWeight(entry, models),
                similarityPenalty: getModelSimilarityPenalty(entry, models),
                details: entry.calculationDetails
            }))
        };
    }

    // 【回測統計口徑說明】舊版本只產出單一組 hitRate / coverage，且把「參考方向」
    // （模型自己判定訊號不足、mode 為「參考方向」的局次）也一併算成正式下注，
    // 導致覆蓋率被推高到約 90%，命中率則被這些低信心局次稀釋成接近隨機值，
    // 使用者因而無法分辨「模型真的有訊號時表現如何」與「沒訊號時亂猜的結果」。
    // 現在改為同時產出三組互不干擾的統計：
    //   - hitRate / coverage         ：全部有方向的局次（維持原語意，不破壞既有測試與呼叫端）
    //   - realHitRate / realCoverage ：僅計入 isReal === true 的真實訊號
    //   - referenceHitRate           ：僅計入參考方向（isReal === false）
    // 三者分開後才能客觀判斷訊號篩選機制到底有沒有辨識能力。
    function runWalkForwardBacktest(history, options = {}) {
        const outcomes = filterValidOutcomesForBacktest(history);
        const warmup = Number.isInteger(options.warmup) && options.warmup >= 1 ? options.warmup : PREDICTION_CONFIG.MIN_SIGNAL_HISTORY;
        // 預設重播「核心引擎 + 下三路輔助強化層」的完整流程，與面板實際推薦一致。
        // 需要單獨檢視核心引擎表現時，可傳入 { useAuxiliary: false } 關閉輔助層。
        const useAuxiliary = options.useAuxiliary !== false;
        // 回測必須從乾淨的模型表現狀態開始，並在每局結算後更新權重，
        // 這樣才會重播即時流程；結束後還原即時狀態，避免回測污染正在運作的面板。
        const savedModelPerformance = modelPerformance;
        modelPerformance = Object.create(null);
        const finishBacktest = result => {
            modelPerformance = savedModelPerformance;
            return Object.freeze(result);
        };
        if (outcomes.length <= warmup) {
            return finishBacktest({
                totalRounds: outcomes.length,
                evaluatedRounds: 0,
                signals: 0,
                wins: 0,
                losses: 0,
                pushes: 0,
                abstentions: 0,
                hitRate: null,
                coverage: 0,
                realWins: 0,
                realLosses: 0,
                realPushes: 0,
                realSignals: 0,
                realHitRate: null,
                realCoverage: 0,
                referenceWins: 0,
                referenceLosses: 0,
                referenceSignals: 0,
                referenceHitRate: null,
                bankerTiltCount: 0,
                targetCounts: Object.freeze({ '莊': 0, '閒': 0 }),
                longestLossStreak: 0,
                realLongestLossStreak: 0,
                confidenceBuckets: Object.freeze([])
            });
        }

        const records = [];
        const confidenceBuckets = [0, 0, 0, 0, 0];
        let wins = 0;
        let losses = 0;
        let pushes = 0;
        let abstentions = 0;
        let currentLossStreak = 0;
        let longestLossStreak = 0;
        let realWins = 0;
        let realLosses = 0;
        let realPushes = 0;
        let referenceWins = 0;
        let referenceLosses = 0;
        let realCurrentLossStreak = 0;
        let realLongestLossStreak = 0;
        let bankerTiltCount = 0;
        const targetCounts = { '莊': 0, '閒': 0 };

        for (let index = warmup; index < outcomes.length; index++) {
            const actual = outcomes[index];
            const history = outcomes.slice(0, index);
            // 【口徑修正】面板與自動下注實際採用的是「核心引擎 → 下三路輔助強化層」的完整流程
            // （見 refreshPrediction 內的 applyAuxiliaryRoadEnhancement(getEnsemblePrediction(...))）。
            // 舊版回測只跑核心引擎，等於在統計一個與使用者實際跟單對象不同的模型，
            // 算出來的命中率自然無法反映真實體感。這裡改為重播完整流程，讓數字對得上。
            const corePrediction = getEnsemblePrediction(history, records);
            const prediction = useAuxiliary ? applyAuxiliaryRoadEnhancement(corePrediction, history) : corePrediction;
            const target = prediction && (prediction.target === '莊' || prediction.target === '閒') ? prediction.target : null;
            const isRealSignal = Boolean(prediction && prediction.isReal);
            const isDirectionalActual = actual === '莊' || actual === '閒';
            let status = 'abstain';

            if (prediction && prediction.bankerTiltApplied) { bankerTiltCount++; }
            if (target) { targetCounts[target]++; }

            if (!target || !isDirectionalActual) {
                if (target && actual === '和') {
                    status = 'push';
                    pushes++;
                    if (isRealSignal) { realPushes++; }
                } else {
                    abstentions++;
                }
                currentLossStreak = 0;
            } else if (target === actual) {
                status = 'win';
                wins++;
                currentLossStreak = 0;
                if (isRealSignal) { realWins++; realCurrentLossStreak = 0; } else { referenceWins++; }
            } else {
                status = 'loss';
                losses++;
                currentLossStreak++;
                longestLossStreak = Math.max(longestLossStreak, currentLossStreak);
                if (isRealSignal) {
                    realLosses++;
                    realCurrentLossStreak++;
                    realLongestLossStreak = Math.max(realLongestLossStreak, realCurrentLossStreak);
                } else {
                    referenceLosses++;
                }
            }

            const confidence = Number(prediction && prediction.kelly && prediction.kelly.stakeFraction);
            const normalizedConfidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence / ULTIMATE_CONFIG.KELLY_CAP)) : 0;
            confidenceBuckets[Math.min(4, Math.floor(normalizedConfidence * 5))]++;
            updateModelPerformance(prediction, actual);
            records.push({
                target,
                status,
                isReal: isRealSignal,
                probabilities: prediction && prediction.probabilities
            });
        }

        const evaluatedRounds = wins + losses + pushes;
        const realEvaluated = realWins + realLosses + realPushes;
        const realSignals = realWins + realLosses;
        const referenceSignals = referenceWins + referenceLosses;
        // 【覆蓋率語意修正】舊版把覆蓋率算成 (勝+負) / (勝+負+和)，
        // 那其實只是在量「下注的局次裡有多少局不是和局」——因為和局本來就約佔 9.5%，
        // 這個數字必然落在 90% 上下，完全反映不出「面板到底多常給出方向」。
        // 正確定義應為：有下注的局次 ÷ 所有可下注的局次（含觀望）。
        const opportunities = evaluatedRounds + abstentions;
        return finishBacktest({
            totalRounds: outcomes.length,
            evaluatedRounds,
            opportunities,
            signals: wins + losses,
            wins,
            losses,
            pushes,
            abstentions,
            hitRate: wins + losses > 0 ? wins / (wins + losses) : null,
            coverage: opportunities > 0 ? evaluatedRounds / opportunities : 0,
            realWins,
            realLosses,
            realPushes,
            realSignals,
            realHitRate: realSignals > 0 ? realWins / realSignals : null,
            realCoverage: opportunities > 0 ? realEvaluated / opportunities : 0,
            referenceWins,
            referenceLosses,
            referenceSignals,
            referenceHitRate: referenceSignals > 0 ? referenceWins / referenceSignals : null,
            bankerTiltCount,
            targetCounts: Object.freeze({ ...targetCounts }),
            longestLossStreak,
            realLongestLossStreak,
            confidenceBuckets: Object.freeze(confidenceBuckets)
        });
    }

    // 【自動回測報告】直接讀取面板自動收集的持久化真實歷史（getPersistedOutcomeHistory），
    // 套用與 runWalkForwardBacktest 完全相同的嚴謹規則（只用當局之前的歷史，不偷看未來），
    // 讓使用者不需要自己手動匯出/貼上歷史序列，就能檢視目前模型在「真實累積牌局」上的表現，
    // 藉此建立 Baseline，並在未來調整模型後重新呼叫本函式比較是否真的有改善。
    function runPersistedBacktest(options = {}) {
        try {
            const history = getPersistedOutcomeHistory();
            return runWalkForwardBacktest(history, options);
        } catch (error) {
            safeDebug('[MT Baccarat] 持久化回測失敗，回傳空報告', error);
            return Object.freeze({
                totalRounds: 0, evaluatedRounds: 0, opportunities: 0, signals: 0, wins: 0, losses: 0,
                pushes: 0, abstentions: 0, hitRate: null, coverage: 0,
                realWins: 0, realLosses: 0, realPushes: 0, realSignals: 0, realHitRate: null, realCoverage: 0,
                referenceWins: 0, referenceLosses: 0, referenceSignals: 0, referenceHitRate: null,
                bankerTiltCount: 0, targetCounts: Object.freeze({ '莊': 0, '閒': 0 }),
                longestLossStreak: 0, realLongestLossStreak: 0,
                confidenceBuckets: Object.freeze([0, 0, 0, 0, 0])
            });
        }
    }

    // ============================================================================
    // 【獨立擴充模組・非侵入式】輔助路型強化層（Auxiliary Road Reinforcement Layer）
    // ------------------------------------------------------------------------------
    // 本模組完全獨立於上方 getEnsemblePrediction() 與其呼叫的所有既有公式（
    // applyPredictiveAdjustments、calculateDynamicKelly、getRoadConsensus、getRoadRegime 等），
    // 不會修改、也不會呼叫這些函式內部的任何一行程式碼。
    //
    // 運作方式：在核心引擎產出完整預測結果之後，以「唯讀」方式重新解讀大眼路/小路/曱甴路的
    // 最新紅藍分布，並額外統計「連開後下一手」與「跳開後下一手」的經驗機率，將這兩組獨立訊號
    // 依信心值加權混合成一個輔助分布，再用有上限的權重與核心機率做 Blend。
    //
    // 安全邊界（經使用者確認的最保守策略）：
    //   1. 若核心目前處於「長龍趨勢」或「穩定單跳」豁免模式（regime.exception === true），
    //      本模組完全略過，原樣回傳核心結果，維持既有「好路特殊豁免機制」100% 優先。
    //   2. 無論輔助訊號如何，最終推薦方向（target）與模式文字（mode）永遠維持核心原值，
    //      絕不翻轉方向；只微調顯示用的機率分布，並附加診斷欄位供事後檢視。
    //   3. 任何步驟拋出例外，一律安全回退為「原始核心 prediction」，不阻斷主流程。
    // ============================================================================
    const AUX_CONFIG = Object.freeze({
        MAX_BLEND_WEIGHT: 0.22,   // 輔助層對顯示機率的最大混合權重上限，避免蓋過核心模型
        MIN_ROAD_SAMPLES: 4,      // 大眼/小/曱甴路至少需要的格數才納入計算
        ROAD_LOOKBACK_MULTIPLIER: 3, // 衍生路回溯格數＝MIN_ROAD_SAMPLES 的倍數
        STREAK_LOOKBACK: 40,      // 連開/跳開統計回溯的局數
        MIN_STREAK_SAMPLES: 3,    // 連開或跳開後續統計所需的最少樣本數
        ROAD_AGREEMENT_BONUS: 0.05 // 三條輔助路方向一致時，額外加成的混合權重
    });

    // 統計單一衍生路（大眼路/小路/曱甴路）最近格子中「紅（延續）」與「藍（改變）」的比例。
    function summarizeDerivedRoad(cells) {
        try {
            if (!Array.isArray(cells) || cells.length < AUX_CONFIG.MIN_ROAD_SAMPLES) return null;
            const recent = cells.slice(-AUX_CONFIG.MIN_ROAD_SAMPLES * AUX_CONFIG.ROAD_LOOKBACK_MULTIPLIER);
            const total = recent.length;
            if (total === 0) return null;
            const redCount = recent.filter(cell => cell && cell.color === '紅').length;
            return { redRatio: redCount / total, samples: total };
        } catch (error) {
            safeDebug('[MT Baccarat][Aux] 衍生路統計略過', error);
            return null;
        }
    }

    // 綜合大眼路/小路/曱甴路的紅藍比例，推算相對於「參考方向」延續或反轉的機率偏移。
    function computeDerivedRoadBias(roads, referenceDirection) {
        try {
            if (!referenceDirection || (referenceDirection !== '莊' && referenceDirection !== '閒')) return null;
            const summaries = [summarizeDerivedRoad(roads && roads['大眼路']), summarizeDerivedRoad(roads && roads['小路']), summarizeDerivedRoad(roads && roads['曱甴路'])].filter(Boolean);
            if (summaries.length === 0) return null;
            const avgRedRatio = summaries.reduce((sum, item) => sum + item.redRatio, 0) / summaries.length;
            const agreementCount = summaries.filter(item => item.redRatio >= 0.5).length;
            const otherDirection = referenceDirection === '莊' ? '閒' : '莊';
            // 紅比例偏離 0.5 的幅度代表「延續」或「反轉」訊號的強弱；乘上 0.5 做溫和縮放，避免過度放大。
            const shift = (avgRedRatio - 0.5) * 0.5;
            const distribution = { '莊': 1 / 3, '閒': 1 / 3, '和': 1 / 3 };
            distribution[referenceDirection] = Math.max(0, 1 / 3 + shift);
            distribution[otherDirection] = Math.max(0, 1 / 3 - shift);
            return {
                distribution,
                agreementCount,
                totalRoads: summaries.length,
                confidence: Math.min(1, summaries.length / 3) * Math.min(1, Math.abs(avgRedRatio - 0.5) * 2)
            };
        } catch (error) {
            safeDebug('[MT Baccarat][Aux] 衍生路偏移計算略過', error);
            return null;
        }
    }

    // 統計「連開後下一手」與「跳開後下一手」的經驗機率（Laplace 平滑，避免小樣本極端值）。
    function computeStreakAlternationBias(outcomes) {
        try {
            const directional = Array.isArray(outcomes) ? outcomes.filter(outcome => outcome === '莊' || outcome === '閒').slice(-AUX_CONFIG.STREAK_LOOKBACK) : [];
            if (directional.length < 6) return null;
            let afterStreakBanker = 0, afterStreakPlayer = 0, afterStreakTotal = 0;
            let afterAlternationBanker = 0, afterAlternationPlayer = 0, afterAlternationTotal = 0;
            for (let index = 2; index < directional.length; index++) {
                const isStreak = directional[index - 1] === directional[index - 2];
                const next = directional[index];
                if (isStreak) {
                    afterStreakTotal++;
                    if (next === '莊') afterStreakBanker++; else afterStreakPlayer++;
                } else {
                    afterAlternationTotal++;
                    if (next === '莊') afterAlternationBanker++; else afterAlternationPlayer++;
                }
            }
            const prevIsStreak = directional.length >= 2 && directional[directional.length - 1] === directional[directional.length - 2];
            const relevantTotal = prevIsStreak ? afterStreakTotal : afterAlternationTotal;
            if (relevantTotal < AUX_CONFIG.MIN_STREAK_SAMPLES) return null;
            const bankerHits = prevIsStreak ? afterStreakBanker : afterAlternationBanker;
            const playerHits = prevIsStreak ? afterStreakPlayer : afterAlternationPlayer;
            const bankerProbability = (bankerHits + 1) / (relevantTotal + 2);
            const playerProbability = (playerHits + 1) / (relevantTotal + 2);
            const directionalSum = bankerProbability + playerProbability;
            return {
                distribution: { '莊': (bankerProbability / directionalSum) * (2 / 3), '閒': (playerProbability / directionalSum) * (2 / 3), '和': 1 / 3 },
                sampleCount: relevantTotal,
                confidence: Math.min(1, relevantTotal / 20)
            };
        } catch (error) {
            safeDebug('[MT Baccarat][Aux] 連開跳開統計略過', error);
            return null;
        }
    }

    // 輔助層總入口（3.0.0）：只做三件事——(1) 以核心方向為基準混合顯示用機率、(2) 在下三路強共振
    // 同向時標註模式文字、(3) 用混合後機率再做一次莊向把關。絕不翻轉方向、絕不擅自升級 isReal，
    // 也絕不在核心無方向時盲猜基準方向，確保與核心引擎的統計口徑完全一致。
    function applyAuxiliaryRoadEnhancement(prediction, seq) {
        try {
            if (!prediction || !prediction.probabilities) return prediction;
            if (prediction.regime && prediction.regime.exception) return prediction; // 長龍/單跳豁免期間完全略過，維持核心 100% 主導。

            // 【3.0.0 統計偏差修復】舊版在核心 target 為 null 時會退而以 '莊' 當基準方向去推算下三路
            // 紅藍偏移，等於憑空製造一個帶莊向偏差的參考點，並可能據此產生方向。
            // 核心引擎給不出明確方向，本層就直接安全回退，不製造任何方向。
            const referenceDirection = prediction.target === '莊' || prediction.target === '閒' ? prediction.target : null;
            if (!referenceDirection) return prediction;

            const outcomesForRoads = getObservedOutcomes(Array.isArray(seq) ? seq : []);
            // 核心引擎若已用同一基準方向解析過下三路共振，直接沿用，避免兩層看到不同結果。
            const resonance = prediction.derivedRoadResonance && prediction.derivedRoadResonance.referenceDirection === referenceDirection
                ? prediction.derivedRoadResonance
                : getDerivedRoadResonance(outcomesForRoads, referenceDirection);
            const roadBias = resonance ? resonance.roadBias : null;
            const streakBias = computeStreakAlternationBias(outcomesForRoads);
            const auxSignals = [roadBias, streakBias].filter(signal => signal && signal.confidence > 0);
            if (auxSignals.length === 0) return prediction; // 資料不足時，原封不動回傳核心結果。

            const totalConfidence = auxSignals.reduce((sum, signal) => sum + signal.confidence, 0);
            if (totalConfidence <= 0) return prediction;
            const auxDistribution = auxSignals.reduce((result, signal) => {
                const weight = signal.confidence / totalConfidence;
                result['莊'] += signal.distribution['莊'] * weight;
                result['閒'] += signal.distribution['閒'] * weight;
                result['和'] += signal.distribution['和'] * weight;
                return result;
            }, { '莊': 0, '閒': 0, '和': 0 });

            const roadAgreementBonus = (resonance && resonance.totalRoads >= 2 && resonance.alignedRoads === resonance.totalRoads) ? AUX_CONFIG.ROAD_AGREEMENT_BONUS : 0;
            const averageConfidence = totalConfidence / auxSignals.length;
            const blendWeight = Math.min(AUX_CONFIG.MAX_BLEND_WEIGHT, averageConfidence * AUX_CONFIG.MAX_BLEND_WEIGHT + roadAgreementBonus);
            const blendedProbabilities = normalizeDistribution({
                '莊': prediction.probabilities['莊'] * (1 - blendWeight) + auxDistribution['莊'] * blendWeight,
                '閒': prediction.probabilities['閒'] * (1 - blendWeight) + auxDistribution['閒'] * blendWeight,
                '和': prediction.probabilities['和'] * (1 - blendWeight) + auxDistribution['和'] * blendWeight,
            });

            // 只標註、不改向：下三路強共振且與核心方向同向時，把模式文字標成對應說明。
            const auxTarget = getDirectionalTarget(auxDistribution);
            const strongSameDirection = Boolean(resonance && resonance.strong && auxTarget === referenceDirection);
            let finalMode = prediction.mode;
            if (strongSameDirection) {
                if (prediction.isReal && prediction.mode === '精算完成') finalMode = '路型加強';
                else if (!prediction.isReal && prediction.mode === '參考方向') finalMode = '下三路共振';
            }

            // 【莊向偏好・二次把關】面板與自動下注實際採用的是本層輸出，因此以混合後的機率再把關一次。
            // 只會把「證據不足的閒」改成莊，不會把莊改成閒。
            const auxBankerTilt = resolveBankerTilt(referenceDirection, blendedProbabilities);

            return {
                ...prediction,
                probabilities: blendedProbabilities,
                target: auxBankerTilt.target,
                rawTarget: prediction.rawTarget || referenceDirection,
                bankerTiltApplied: Boolean(prediction.bankerTiltApplied) || auxBankerTilt.applied,
                playerEdge: auxBankerTilt.playerEdge,
                mode: finalMode,
                isReal: prediction.isReal,
                auxiliaryEnhancement: Object.freeze({
                    applied: true,
                    blendWeight,
                    referenceDirection,
                    auxTarget,
                    strongSameDirection,
                    roadBias,
                    streakBias,
                    resonance,
                    originalProbabilities: prediction.probabilities
                })
            };
        } catch (error) {
            safeDebug('[MT Baccarat][Aux] 輔助強化層計算失敗，已安全回退為核心原始預測', error);
            return prediction;
        }
    }


    const BaccaratAPI = Object.freeze({
        version: BACCARAT_API_VERSION,
        calculateCardPoints,
        bankerDraws,
        analyzeHand,
        analyzeRoads,
        simulateRoadInquiry,
        analyzeRoadPatterns,
        calculateEntropy,
        calculateBinaryEntropy,
        calculateConsensusDisagreement,
        kalmanFilterEntropy,
        getRoadRegime,
        getRoadConsensus,
        calculateDynamicKelly,
        estimateRemainingShoe,
        getMultiTimeframeProfile,
        applyPredictiveAdjustments,
        getEnsemblePrediction: (seq, records) => getEnsemblePrediction(seq, records),
        getDynamicMarkovMatrix: (seq) => {
            const outcomes = getObservedOutcomes(Array.isArray(seq) ? seq : []);
            return getDynamicMarkovMatrix(outcomes, outcomes.filter(outcome => outcome === '莊' || outcome === '閒'));
        },
        getDerivedRoadResonance: (seq, referenceDirection) => getDerivedRoadResonance(getObservedOutcomes(Array.isArray(seq) ? seq : []), referenceDirection),
        runWalkForwardBacktest,
        getPersistedOutcomeHistory,
        appendPersistedOutcome,
        clearPersistedOutcomeHistory,
        runPersistedBacktest,
        applyAuxiliaryRoadEnhancement: (prediction, seq) => applyAuxiliaryRoadEnhancement(prediction, seq),
        strategies: Object.freeze({
            martingale: martingaleStake,
            fibonacci: fibonacciStake,
            getRiskControlledStake,
            advanceRiskState
        }),
    });
    if (typeof window !== 'undefined') {
        try {
            if (!window.MTBaccaratAPI) window.MTBaccaratAPI = BaccaratAPI;
        } catch (error) {
            try {
                if (typeof console !== 'undefined' && typeof console.debug === 'function') console.debug('[MT Baccarat] API 掛載失敗', error);
            } catch (_) {
                // API 掛載失敗不可阻斷瀏覽器主流程。
            }
        }
    }

    let wsLiveScores = null;
    let lastLoggedWsCounts = null;

    (function hookWebSocket() {
        const wrappedMarker = '__mtBaccaratWebSocketWrapped__';
        const processMessage = (event) => {
            try {
                if (typeof event.data !== 'string' || !event.data.includes('{')) return;
                const packet = JSON.parse(event.data);
                if (!packet || packet.bankerCount === undefined || packet.playerCount === undefined) return;
                wsLiveScores = { b: parseInt(packet.bankerCount, 10), p: parseInt(packet.playerCount, 10), t: parseInt(packet.tieCount || 0, 10) };
                if ([wsLiveScores.b, wsLiveScores.p, wsLiveScores.t].every(Number.isInteger) && [wsLiveScores.b, wsLiveScores.p, wsLiveScores.t].every(value => value >= 0) && (!lastLoggedWsCounts || lastLoggedWsCounts.b !== wsLiveScores.b || lastLoggedWsCounts.p !== wsLiveScores.p || lastLoggedWsCounts.t !== wsLiveScores.t)) {
                    lastLoggedWsCounts = { ...wsLiveScores };
                    writeDataLog('websocket-round-counts', { counts: { ...wsLiveScores } });
                }
            } catch (error) { safeDebug('[MT Baccarat] 忽略無效 WebSocket 封包', error); }
        };
        const installWebSocketHook = (targetWindow, label) => {
            try {
                if (!targetWindow || typeof targetWindow.WebSocket !== 'function') return false;
                const original = targetWindow.WebSocket;
                if (original[wrappedMarker]) return true;
                const WrappedWebSocket = function (...args) {
                    const socket = new original(...args);
                    if (socket && typeof socket.addEventListener === 'function') socket.addEventListener('message', processMessage);
                    return socket;
                };
                WrappedWebSocket.prototype = original.prototype;
                Object.defineProperty(WrappedWebSocket, wrappedMarker, { value: true });
                targetWindow.WebSocket = WrappedWebSocket;
                return true;
            } catch (error) { safeDebug('[MT Baccarat] 略過無法存取的 ' + label + ' WebSocket', error); return false; }
        };
        const scanSameOriginFrames = (rootWindow, visited = new Set()) => {
            if (!rootWindow || visited.has(rootWindow)) return;
            visited.add(rootWindow);
            installWebSocketHook(rootWindow, 'frame');
            try {
                const frames = rootWindow.document && rootWindow.document.querySelectorAll('iframe');
                if (frames) frames.forEach(frame => { try { scanSameOriginFrames(frame.contentWindow, visited); } catch (error) { safeDebug('[MT Baccarat] 略過跨來源 iframe', error); } });
            } catch (error) { safeDebug('[MT Baccarat] iframe 掃描失敗', error); }
        };
        scanSameOriginFrames(window);
        try { if (window.parent && window.parent !== window) scanSameOriginFrames(window.parent); } catch (error) { safeDebug('[MT Baccarat] 略過跨來源 parent', error); }
        if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.documentElement) {
            const frameObserver = new MutationObserver(() => scanSameOriginFrames(window));
            frameObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
    })();
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        window.addEventListener('DOMContentLoaded', initCoreEngine);
        if (document.readyState === 'interactive' || document.readyState === 'complete') {
            initCoreEngine();
        }
    }

    function initCoreEngine() {
        const isMTSite = location.hostname.includes('ofalive99.net') || document.title.includes('MT');
        if (!isMTSite) return;

        if (document.getElementById('baccarat-ultimate-engine')) return;

        function isAuthorizationValid() {
            const expiry = new Date(`${CONFIG.EXPIRE_DATE}T23:59:59`);
            return Number.isFinite(expiry.getTime()) && new Date() <= expiry;
        }

        function showExpiredModal() {
            if (document.getElementById('baccarat-expired-modal')) return;
            const modal = document.createElement('div');
            modal.id = 'baccarat-expired-modal';
            modal.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999999;background:#1a1c23;border:1px solid #ef4444;border-radius:10px;padding:12px 16px;font-family:sans-serif;color:#fff;';
            modal.innerHTML = `<div style="font-size:13px;font-weight:bold;color:#ef4444;">系統授權已失效</div><div style="font-size:10px;color:#888;margin-top:4px;">到期日：${CONFIG.EXPIRE_DATE}</div>`;
            document.body.appendChild(modal);
        }

        if (!isAuthorizationValid()) {
            showExpiredModal();
            return;
        }

        let autoDetectEnabled = false;
        let lastB = -1, lastP = -1, lastT = -1;
        let gameSequence = [];
        let actualRoundHistory = [];
        let predictionRecords = [];
        let pendingPrediction = null;
        let roundNumber = 0;
        let predictionStartRound = null;
        let currentStreak = 0;
        let strategyLossStreak = 0;
        let shadowMode = false;
        let shadowWins = 0;
        let shadowLosses = 0;
        let shadowSuccessStreak = 0;
        let headerTimeTimer = null;
        let scanTimer = null;
        let roomObserver = null;
        let scannerGeneration = 0;
        let panelScale = 1.0;
        let scoreElementCache = null;
        let roomReady = false;
        let observationRounds = 0;
        // 【獨立擴充】自動下注控制狀態：與既有偵測/局勢狀態完全獨立，不受 resetPredictionSession() 影響，
        // 也不做任何持久化（每次重新載入頁面一律重置為 OFF / 100）。
        let autoBetEnabled = false;
        let autoBetAmount = 100;
        let martingaleEnabled = false;
        let martingaleAmount = autoBetAmount;
        let lastAutoBetRound = null; // 記錄上次已觸發模擬下注的局號，避免同一局重複觸發。
        const OBSERVATION_ROUNDS = ULTIMATE_CONFIG.OBSERVATION_ROUNDS;
        const isMobileHost = /Android|iPhone|iPad/i.test(typeof navigator !== 'undefined' ? navigator.userAgent : '') || (typeof window !== 'undefined' && !window.chrome);
        const MOBILE_ROOM_READY_DELAY_MS = 3000;
        let scannerStartedAt = 0;

        const container = document.createElement('div');
        container.id = 'baccarat-ultimate-engine';
        container.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 9999999;
            background:
                linear-gradient(145deg, rgba(255,255,255,0.075), transparent 34%),
                linear-gradient(160deg, rgba(18,18,20,0.75), rgba(15,17,26,0.82));
            background-clip: padding-box, border-box;
            color: #f5f5f7;
            padding: 15px;
            border: 1px solid transparent;
            border-radius: 16px;
            font-family: Inter, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
            width: 268px;
            box-sizing: border-box;
            user-select: none;
            touch-action: auto;
            transform-origin: top right;
            backdrop-filter: blur(16px) saturate(135%);
            -webkit-backdrop-filter: blur(16px) saturate(135%);
            box-shadow: 0 8px 32px rgba(0,0,0,0.37), 0 24px 64px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.12);
            isolation: isolate;
            overflow: hidden;
        `;

        const styleElem = document.createElement('style');
        styleElem.innerHTML = `
            :root {
                --gold: #d6b56a;
                --gold-light: #f3d99a;
                --gold-muted: #a78b50;
                --bg-dark: #121214;
                --bg-card: rgba(255,255,255,0.055);
                --text-gray: #8e8e93;
                --text-main: #f5f5f7;
                --red: #e0474c;
                --blue: #2f69e3;
                --green: #63d89a;
                --border-color: rgba(255, 255, 255, 0.11);
            }

            #baccarat-ultimate-engine::before {
                content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
                border-radius: inherit; padding: 1px;
                background: linear-gradient(135deg, rgba(255,255,255,0.48), rgba(255,255,255,0.06) 42%, rgba(255,255,255,0.18));
                -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
                -webkit-mask-composite: xor; mask-composite: exclude;
            }
            .ly-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; cursor: move; }
            .ly-brand { display: flex; align-items: center; gap: 8px; }
            .ly-logo {
                width: 42px; height: 42px;
                border: none; border-radius: 50%;
                background: transparent;
                display: flex; align-items: center; justify-content: center;
                color: var(--gold-light); font-weight: 900; font-size: 12px;
                overflow: hidden;
                filter: drop-shadow(0 4px 10px rgba(0,0,0,0.48));
            }
            .ly-logo-image {
                width: 42px; height: 42px; object-fit: contain; display: block; border: none;
                border-radius: 50%;
                -webkit-mask-image: radial-gradient(circle, #000 58%, rgba(0,0,0,0.92) 72%, transparent 100%);
                mask-image: radial-gradient(circle, #000 58%, rgba(0,0,0,0.92) 72%, transparent 100%);
                filter: saturate(1.08) contrast(1.04);
            }
            .ly-title {
                display: inline-block;
                transform: translateY(-3px);
                background: linear-gradient(100deg, #fff0b0 0%, #e7bd55 42%, #f6d8a8 72%, #b9872f 100%);
                -webkit-background-clip: text;
                background-clip: text;
                color: transparent;
                font-size: 14px;
                font-weight: 900;
                line-height: 1.15;
                letter-spacing: 0.65px;
                text-shadow: 0 1px 14px rgba(243,217,154,0.26);
            }
            .ly-subtitle { color: var(--text-gray); font-size: 9px; font-weight: 600; letter-spacing: 0.8px; transform: translateY(-2px); text-transform: uppercase; }

            .ly-zoom-capsule {
                display: flex; align-items: center; gap: 4px;
                border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.24);
                border-radius: 20px; padding: 3px 6px;
            }
            .ly-zoom-btn {
                background: transparent; border: none; color: var(--gold-light); font-size: 12px;
                font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center;
                width: 14px; height: 14px; padding: 0;
            }
            .ly-zoom-btn:hover { color: #fff; transform: scale(1.15); }
            .ly-zoom-val { font-size: 9px; color: var(--gold); font-weight: bold; min-width: 26px; text-align: center; }

            .ly-time { display: flex; align-items: center; justify-content: flex-start; gap: 6px; color: var(--text-gray); font-size: 9px; margin: -1px 0 12px 50px; letter-spacing: 0.4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
            .ly-dot { width: 5px; height: 5px; background-color: var(--gold-light); border-radius: 50%; box-shadow: 0 0 10px rgba(243,217,154,0.75); }

            .ly-toolbar { display: flex; gap: 7px; margin-bottom: 12px; }
            .ly-btn-main {
                flex: 1; background: linear-gradient(135deg, rgba(214,181,106,0.24), rgba(255,255,255,0.035));
                border: 1px solid rgba(255,255,255,0.2); color: var(--gold-light);
                border-radius: 12px; padding: 9px 0; font-size: 11px; font-weight: 800; cursor: pointer; transition: all 0.3s ease;
            }
            .ly-btn-main.is-active {
                background: linear-gradient(135deg, rgba(74,222,128,0.3), rgba(34,197,94,0.1));
                border-color: var(--green);
                color: #bbf7d0;
                box-shadow: 0 0 14px rgba(74,222,128,0.18);
            }
            .ly-btn-sub {
                width: 58px; background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.14); color: var(--text-gray);
                border-radius: 12px; font-size: 11px; font-weight: bold; cursor: pointer; transition: all 0.3s ease;
            }
            .ly-btn-main:hover, .ly-btn-sub:hover { filter: brightness(1.2); transform: translateY(-1px); }
            .ly-btn-main:active, .ly-btn-sub:active { transform: translateY(0); }
            .ly-btn-main:disabled { opacity: 0.48; cursor: not-allowed; filter: grayscale(0.35); transform: none; }

            .ly-stats-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }
            .ly-stats-title { display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 800; color: #eee9df; }
            .ly-stats-rounds { font-size: 10px; color: var(--text-gray); font-weight: bold; }

            /* direction: ltr 明確鎖定排版方向，避免宿主頁面（遊戲網站）繼承 RTL 或其他全域樣式，
               導致莊/閒視覺順序被意外反轉。搭配下方 order 屬性，確保「莊左、閒右、和最後」100% 固定。 */
            .ly-stats-boxes { display: flex; direction: ltr; gap: 6px; margin-bottom: 12px; }
            .ly-stat-box {
                flex: 1; background: linear-gradient(150deg, rgba(255,255,255,0.085), rgba(255,255,255,0.025));
                border-radius: 12px; border: 1px solid rgba(255,255,255,0.115);
                display: flex; flex-direction: column; align-items: center; padding: 9px 0; gap: 3px;
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.07), 0 5px 14px rgba(0,0,0,0.14);
            }
            .ly-stat-box span { font-size: 11px; font-weight: bold; }
            .ly-stat-box strong { font-size: 18px; font-weight: 900; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; transition: all 0.3s ease; }
            .box-banker { order: 1; }
            .box-player { order: 2; }
            .box-tie { order: 3; }
            .box-banker span, .box-banker strong { color: var(--red); }
            .box-player span, .box-player strong { color: var(--blue); }
            .box-tie span, .box-tie strong { color: var(--green); }

            .ly-prediction {
                border: 1px solid rgba(255,255,255,0.16); border-radius: 16px; padding: 14px;
                background: linear-gradient(160deg, rgba(255,255,255,0.085), rgba(255,255,255,0.025) 46%, rgba(0,0,0,0.2));
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.1), 0 8px 32px rgba(0,0,0,0.37);
            }
            .ly-pred-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 11px; }
            .ly-pred-title { font-size: 12px; font-weight: 800; color: #f5f0e6; letter-spacing: 0.25px; }
            .ly-pred-badge {
                border: 1px solid rgba(255,255,255,0.18); color: var(--gold-light); font-size: 9px;
                padding: 3px 8px; border-radius: 10px; font-weight: bold;
                background: rgba(255,255,255,0.06);
            }

            .ly-target-area { text-align: center; margin-bottom: 12px; }
            .ly-target-label { font-size: 10px; color: var(--text-gray); margin-bottom: 6px; font-weight: bold; letter-spacing: 0.35px; }
            /* direction: ltr 鎖定推薦方向區塊的排版方向；is-player 固定 order:1（左）、
               is-banker 固定 order:2（右），雙重保險避免宿主頁面樣式干擾視覺順序。
               （依需求：下局推薦方向區塊為「閒左、莊右」，與上方即時數據統計列的「莊/閒/和」順序各自獨立，互不影響。） */
            .ly-target-value { display: flex; direction: ltr; justify-content: center; gap: 7px; min-height: 34px; }
            .ly-direction-option {
                min-width: 68px; padding: 7px 12px; box-sizing: border-box; border-radius: 10px;
                border: 1px solid rgba(255,255,255,0.14); color: var(--text-gray);
                background: rgba(0,0,0,0.22); font-size: 16px; font-weight: 900;
                letter-spacing: 1px; transition: all 0.3s ease; text-shadow: none; opacity: 0.72;
            }
            .ly-direction-option.is-player { order: 1; color: rgba(47,105,227,0.78); }
            .ly-direction-option.is-banker { order: 2; color: rgba(224,71,76,0.72); }
            .ly-direction-option.is-active {
                transform: translateY(-1px) scale(1.035); color: #fff; border-color: currentColor; opacity: 1;
                box-shadow: 0 0 16px currentColor, inset 0 0 12px rgba(255,255,255,0.08);
            }
            .ly-direction-option.is-active.is-banker { color: #e0474c; background: rgba(224,71,76,0.16); text-shadow: 0 0 12px rgba(224,71,76,0.7); }
            .ly-direction-option.is-active.is-player { color: #2f69e3; background: rgba(47,105,227,0.16); text-shadow: 0 0 12px rgba(47,105,227,0.72); }
            .ly-target-value.color-neutral { color: var(--text-gray); font-size: 12px; align-items: center; }

            .ly-rate-row { display: flex; justify-content: space-between; font-size: 10px; color: var(--text-gray); margin-bottom: 6px; }
            .ly-rate-val { color: var(--gold-light); font-weight: bold; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; transition: all 0.3s ease; }

            .ly-metrics {
                display: flex; border-top: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color);
                padding: 7px 0; margin-bottom: 9px;
            }
            .ly-metric { flex: 1; text-align: center; font-size: 9px; color: var(--text-gray); font-weight: bold; }
            .ly-metric strong { color: var(--text-main); font-size: 11px; margin-left: 2px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
            .ly-metric:not(:last-child) { border-right: 1px solid var(--border-color); }

            .ly-footer { display: flex; justify-content: space-between; font-size: 9px; color: var(--text-gray); font-weight: bold; }
            .ly-footer-streak { color: var(--gold); }

            /* 【獨立擴充】自動下注控制列樣式，沿用既有玻璃擬態圓角與莊/閒配色語彙，
               不修改任何既有選擇器的既有規則。 */
            .ly-autobet-row {
                display: grid; grid-template-columns: auto auto; justify-content: space-between; align-items: center;
                margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--border-color);
                column-gap: 18px; row-gap: 10px;
            }
            .ly-autobet-toggle-group, .ly-autobet-amount-group { display: flex; align-items: center; gap: 6px; min-width: 0; }
            /* 【浮水印格】與 DOM 順序（第 4 個格子）自然落在第 2 列第 2 欄，
               剛好對齊上方「倍投」欄位；row-gap 10px 確保上下兩排不會貼在一起。 */
            .ly-watermark-row { justify-self: center; }
            .ly-autobet-label { font-size: 9px; color: var(--text-gray); font-weight: bold; white-space: nowrap; }
            .ly-autobet-switch {
                min-width: 40px; padding: 4px 8px; border-radius: 10px; cursor: pointer;
                border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.22);
                color: var(--text-gray); font-size: 10px; font-weight: 900; letter-spacing: 0.5px;
                transition: all 0.25s ease; white-space: nowrap; flex-shrink: 0;
            }
            .ly-autobet-switch.is-active {
                color: #4ade80; border-color: rgba(74,222,128,0.55); background: rgba(74,222,128,0.14);
                box-shadow: 0 0 10px rgba(74,222,128,0.35);
            }
            .ly-autobet-input {
                width: 58px; min-width: 0; padding: 4px 5px; border-radius: 8px; box-sizing: border-box;
                border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.22);
                color: var(--text-main); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                font-variant-numeric: tabular-nums; text-align: right;
            }
            .ly-autobet-input:focus { outline: none; border-color: rgba(214,181,106,0.55); }

            .ly-backtest-card {
                margin-top: 9px; padding-top: 10px; border-top: 1px solid var(--border-color);
            }
            .ly-backtest-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; gap: 8px; }
            .ly-backtest-title { display: flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 800; color: #eee9df; white-space: nowrap; }
            .ly-backtest-btn {
                background: linear-gradient(135deg, rgba(214,181,106,0.24), rgba(255,255,255,0.035));
                border: 1px solid rgba(255,255,255,0.2); color: var(--gold-light);
                border-radius: 10px; padding: 4px 10px; font-size: 10px; font-weight: 800; cursor: pointer;
                transition: all 0.25s ease; white-space: nowrap; flex-shrink: 0;
            }
            .ly-backtest-btn:hover { filter: brightness(1.2); transform: translateY(-1px); }
            .ly-backtest-btn:disabled { opacity: 0.5; cursor: not-allowed; filter: grayscale(0.3); transform: none; }
            .ly-backtest-grid {
                display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px;
                margin-bottom: 8px;
            }
            .ly-backtest-item {
                display: flex; flex-direction: column; align-items: center; gap: 2px;
                background: linear-gradient(150deg, rgba(255,255,255,0.06), rgba(255,255,255,0.015));
                border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 7px 0;
            }
            .ly-backtest-item span { font-size: 9px; color: var(--text-gray); font-weight: bold; }
            .ly-backtest-item strong { font-size: 14px; font-weight: 900; color: var(--gold-light); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
            .ly-backtest-status { font-size: 9px; color: var(--text-gray); text-align: center; line-height: 1.4; }
            .ly-backtest-status.is-warn { color: #f3d99a; }

            /* 【基準線對照】命中率若沒有對照組，單一數字很容易被誤讀。
               這一列固定顯示「隨機基準 / 全押莊 / 本模型」三個數字，
               讓使用者一眼看出目前表現究竟是優於、等於還是劣於不看牌路的數學基準。 */
            .ly-backtest-baseline {
                display: flex; justify-content: space-around; align-items: center;
                gap: 4px; margin-bottom: 6px; padding: 5px 4px;
                background: rgba(255,255,255,0.03);
                border: 1px solid rgba(255,255,255,0.07); border-radius: 8px;
            }
            .ly-backtest-baseline div { display: flex; flex-direction: column; align-items: center; gap: 1px; }
            .ly-backtest-baseline span { font-size: 8px; color: var(--text-gray); font-weight: bold; }
            .ly-backtest-baseline b {
                font-size: 11px; font-weight: 800; color: var(--text-gray);
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums;
            }
            .ly-backtest-baseline b.is-model { color: var(--gold-light); }
            .ly-backtest-baseline b.is-above { color: #7dd3a0; }
            .ly-backtest-baseline b.is-below { color: #e88b8b; }
            .ly-backtest-sub {
                font-size: 8.5px; color: var(--text-gray); text-align: center;
                line-height: 1.5; margin-bottom: 6px; opacity: 0.85;
            }

            /* 【浮水印觸發標籤】放在金額輸入框旁，預設低調不搶視覺，點擊後才展開長期戰績面板 */
            .ly-watermark {
                font-size: 9px; color: var(--gold-light); opacity: 0.42; font-weight: 700;
                letter-spacing: 0.5px; white-space: nowrap; cursor: pointer; user-select: none;
                transition: opacity 0.2s ease; flex-shrink: 0;
            }
            .ly-watermark:hover, .ly-watermark:focus-visible { opacity: 0.85; }

            /* 【縮放型面板容器】收合時完全不佔版面、不可互動；展開時以縮放+淡入動畫呈現 */
            .ly-backtest-wrapper {
                overflow: hidden; transition: max-height 0.28s ease, opacity 0.28s ease, transform 0.28s ease, margin-top 0.28s ease;
                transform-origin: top right;
            }
            .ly-backtest-wrapper.is-collapsed {
                max-height: 0; opacity: 0; transform: scale(0.9); pointer-events: none; margin-top: 0;
            }
            .ly-backtest-wrapper:not(.is-collapsed) {
                max-height: 420px; opacity: 1; transform: scale(1); pointer-events: auto; margin-top: 9px;
                padding-top: 10px; border-top: 1px solid var(--border-color);
            }
            .ly-backtest-wrapper .ly-backtest-card { margin-top: 0; padding-top: 0; border-top: none; }

            /* 【密碼閘門】解鎖前顯示，取代原本一律可見的戰績卡片 */
            .ly-backtest-gate { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 4px 0 2px; }
            .ly-backtest-gate-label { font-size: 10px; color: var(--text-gray); font-weight: bold; }
            .ly-backtest-gate-row { display: flex; align-items: center; gap: 6px; width: 100%; justify-content: center; }
            .ly-backtest-pass-input {
                background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.18);
                color: #eee9df; border-radius: 8px; padding: 5px 8px; font-size: 11px; width: 120px;
                text-align: center; letter-spacing: 1px;
            }
            .ly-backtest-pass-input:focus { outline: none; border-color: rgba(214,181,106,0.55); }
            .ly-backtest-pass-error { font-size: 9px; color: #ff8a8a; min-height: 12px; text-align: center; }
            @keyframes ly-shake { 10%, 90% { transform: translateX(-1px); } 20%, 80% { transform: translateX(2px); } 30%, 50%, 70% { transform: translateX(-4px); } 40%, 60% { transform: translateX(4px); } }
            .ly-backtest-gate.is-shake { animation: ly-shake 0.4s ease; }

            button:focus { outline: none; }
            button:focus-visible { box-shadow: 0 0 0 2px rgba(243,217,154,0.45); }
            @keyframes ly-fade-scale { from { opacity: 0.45; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
            .ly-target-value.ly-refresh, .ly-stat-box strong.ly-refresh, .ly-rate-val.ly-refresh { animation: ly-fade-scale 0.3s ease; }
            @media (prefers-reduced-motion: reduce) {
                .ly-target-value, .ly-stat-box strong, .ly-rate-val, .ly-direction-option, .ly-btn-main, .ly-btn-sub { animation: none; transition: none; }
            }
            @media (max-width: 767px) {
                #baccarat-ultimate-engine { right: 8px !important; top: 8px !important; width: min(268px, calc(100vw - 16px)); background: rgba(18, 18, 20, 0.95); -webkit-backdrop-filter: none; backdrop-filter: none; transform: translate3d(0, 0, 0) scale(0.85); }
            }
            @media (max-width: 420px) {
                #baccarat-ultimate-engine { right: 10px !important; top: 10px !important; width: 226px; }
            }
        `;
        document.head.appendChild(styleElem);

        container.innerHTML = `
            <div id="panel-header" class="ly-header">
                <div class="ly-brand">
                    <div class="ly-logo"><img class="ly-logo-image" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAArPSURBVFhH1Zd5bFTXFcbvvDfzZnlv9n2fsceezR6P7fGM7bE92NjYeAVjm8WAAWMC2BBCcBClBkIMTkhcCDQJpEQNRGShiZPWDglJhZpUatykoKa0SSuIFKlNm0LVoEqVukjnq0yaRiWN0vWP/v68Vzrf0b3nnvNdxv4P4RljVsZYlDF1hskNtUxuyjDmiP51fW7/f4HGyZi606JWT3h0pmmbMXBJa4ldlVyp9yV/9qq5qP2Sf9666fzm4Qlv83AnYz7nrRH+TSQLY6qBgMTNVNv4awmLCK/RDr3eA9HghcYcgtZZBIOvHI5YE/Kyq5Bbve/air2nZpYc/OYAK9xguTXiv4A8ZVPKTmcsshsJIwenhoeck8Mg8JDUIjiVmQTJTqK9AAZPMbkTLbAUNMIaX4T8xfuwZHzqxq6n3zrdOP5i6tbIX4iDF1pTVtlsk4eDW8OBYzIwxsgoyEjNy6grxIgxGZkkBfEygRjTEdPGoHZWwhptQWDeBpjr70DZmklsefTbs2uevtR6q8bnEtW4W0fmqS9vr1bAp+IgZ4wWBhhVeBipZYyqHYwGY4xWx3myiEpK+nRgvBsabYCYGAKTiqAwVZA3s4Ls87fC1rYHA8deurz53M++OAkzU6f607rZL81XYFvKhIGYSGYlo4yO0et36elIr5LGKhhNpBm90K+iPZ1mWp7Qkt8Xp0iwhOzBWuIsFeBd9WCeDljSA4itvA/WzU9i6FvvzG67eP3zryOiZeaBCv2pM7v86A4qkLUoYOJk1FfA6PxkIWbvsWOqTYZNEZ6WhpRUaRPpvk49PTvspf29SWrPdVC2YYREdwOYKQPO3wkWXQ3/0CPomrmK0Su/w9SHvz81f+od863aNynTsIEj6z03ttZbUGeRU0zHUb1bRns61XThNjUenCdHj4NRsY6ntjw5NftVlHUo6cE+Cz2/v5VO7l5FCxpGqLh5ggR3I1h+H4SF+1F4YhYb3/oQK1/7AF1n3r5x57mfDdyqzXwajXNxPvfivmYBNVYF0haB3IzhvpwcH56x4o31DJvyGN0WZ9QV5KjCpqCkmacym5a6E25aV19JxzfE6LnRKtqyahO1dg6RVNABWfEgvHu/ibwTP8DCyfOI7Hgew8+/O7PtGv19nwjwrOu2JH+9NajAQreSqswcjS9R4u2nM/TBUSO+t0GLDTEVFep0lLKrqc4p0JJEPrnMYegNGVTFW+ixLXG6NBnE28fK6cJDS2lseDGpgm3QN+2Ab+dZ+NYeRbD/AWRGz14f++kfuv4m3ssYv9AjmxhOy1FkFFAgKsitYNQX5fDWbhE/GRLw9W4TOkMSldgsVGAyQuBFSgVD1Jgop3h+DsWlI1Tqj1FH1ExT+7P00aud+OjNnbTjjvXE9NVQJ/vhaNuF/LWTCPQcQsfh8xOs9+zHbTspMetgVDY9muVRalIhIsopbWL0SBfDr+8XcGFIi16vHB35BnLZElAYyhCzSJRxmRE0uSkXilFZtJvikdXER9Yjs/U4HVxfTK/cU4Sv7NtKTJOE3FkJhb0Gnu49cHYfROVtX5lO7jo3NzsYGxBY5FSncPHhXjUaLDxCKo5WuBk906PAm/tEHMtytG++jsriDaQxpMnjiMCqkVPCoaHNlQosiwvoKxBwZluKRieP0tIDJyju99FoTk3PH+6lTF0bMW0xeF0MrqZh2JrvQtHSsYtVD7wcuZnAa5Us/avHy6+8c18C+5IM5TpGy3wyeuNeEQdzKkytEOnOnI0Cjlqq8gXhVs11QQWF3Rba2Siiq1iOngKOdlbJaHeDQIcWqejlPQ768aMBvHe2hn7zw72UTqdJZkhA5q6GMrEM3vbRK6aRx9M3E/j1vazmTx/sfB/vbsCLKxnanTzWJzkcWyTDGq+EA81BqvTnEHbVoC3fgCIjo7nWbNRo4DEYETYKyHg16Awq0eiRk5bnUBsz4OSIBXc0GenBgTB6cjEwuQeCpwrW+VshVg++r2rfW3MzgalaXfq9461X3rq7FIfqQ5if56WYQUbNLjtqnSVIe3NUVLgWqWAOdzfp8dU2GeIig5xTQ6NQwKxSQM1x0CsFdBbraUm5SAKTgzE1Uj4zumsziBSWQKb0gbeXg/fmIBQtviJvuOvjExgoLIocaG25ONaQRFteHQLGEjBmoI7KdZRNrCRBiMNuqUd1pJVub5lH75300bkhHgscMviUMrJrVSRjMnCMkUHO0YYqkToKVeS1WEhyJqkw2w9dog+csQTKQA68swrqspUXzd0HPq6BGkfI2pdqn961qB8V3la0JlrIr7bSguwwlcZXQlAk4HYuRmVRHw2Uhej7uzX4/etJ/OiwB5MtMrTYGekYw1xdyBij+V4ZnRvPp03NTkq2DVFk7yuI73gSynA3hLxG8O4czE3bpkNrD3z8CuZsVDqwZOKJ/ccxmPky7ll+Fw2VlpPP0UJ+71IYjV3QSDWwGmLUFXbQoVoOb97txy+fK8CfvxfDr6YL8ezBMLJBNd0c2UqBDnUpaUm5nXzBBDIVWegLF0AV64WU6IWyoA2Vtz8ywVjvp/atXFrf9dTdU9df2PUSVpTtp1ykh0RlDVz2foS8a2E0NMFurSe/JUxpt4G+upDhp7s5/HYmjD++twB//nEOH73kwJHhINklDaq9ClILWtpYZ6P7+3zglX64MythzW5BfNn49bGnZj/thHP4LP3OLR1HX3zmnpeQtAwi4VtOkjoHSduNWOGdcFn6kOfvh8eagVkXpboCFw1nzTTWpMQbOxiujDL8/LQXfzxfg72tVpI4jrQaPTVEHSgMRiEGcjDUbYYxdyeGHv7OzLbn3vmsZywLDA7saD90Y0fPQ3AZ2lHg7oXZvAa+0AHkeYcRDgzBbW+HVpeE2VpONnMxOcxhLCtx4BtL5fjhEQem1mnQYWOwSxIZzEEy+1KkcFXDUD0IWXIQFSMnbtx/4epnp+EcqyLHzHtanzj1tZEZZPL74Xf1oyi0mUTtMDRiD0z6BdCKGYiaGCRjCemsKdKZ4ojll9OqUg/15zOqs3JUomeUZ3OQ5EyRmN9EYmYIXNlm2LvGMfrMm6cWvfqLf+wH5lhXOp7aWLFzdlfH7ciGN6I0tIfuWHuBqhLjkMsrwPM+KFU+4ngTOIUZonbufi0IuwMUdOSRRm2jYp+LDHo/afLboM0MQShZg+CaR7Hx5HdnV73w7uc7ok/oLmprPbyo5/L3D4/h+PbT2NB9jppyD5PD1UmCOgSON5KM1xOntIJxOvCSF6IlBpUhAl7Mg8FRBJW/jgzVm2BND8FeOYj0yGOXG/c/+8We8BMmW8pbL+9rnL04OYCJ/m1IFuyA2d5LkrGCJGea1O4kCYZ88GoXlLYyqL010IYaYCzuIqW7DoKzDpKvHvFVRxBb/eCsJbn8nxf/hOONutR4pf/0WOuiGw8MfwNV0c0wG6NQigGovVkojYXgTWXgXM1Q2SqhdFZCaU/B4MnAWr4CvvaxGwVrj51m3sYvPvbPY3uu3NISmT+Qiw7NlHjar7UkqlESLIHNFobZV45I516ktz4DS3I1rHnzEM6swNLtD12z5UZnFK6muWr/T35Gn9LsK3OmvKlOn9Y1YRWt0zad95IxuOBqZvsT7y888tpVXe3oJVOgeVrvaZhgQriTMfbZd/7fAGcZn5Qkq0MyRQMme4bJo7WM1WQYM0UZk/7l3/FfALiRqTA/uSYbAAAAAElFTkSuQmCC" alt="龍盈科技 Logo"></div>
                    <div>
                        <div class="ly-title">龍盈科技</div>
                        <div class="ly-subtitle">MT 百家樂</div>
                    </div>
                </div>
                <div class="ly-zoom-capsule">
                    <button id="btn-zoom-out" class="ly-zoom-btn">−</button>
                    <span id="label-zoom-level" class="ly-zoom-val">100%</span>
                    <button id="btn-zoom-in" class="ly-zoom-btn">+</button>
                </div>
            </div>

            <div class="ly-time">
                <div class="ly-dot"></div>
                <span id="header-time-line">2026-00-00 00:00:00</span>
            </div>

            <div class="ly-toolbar">
                <button id="btn-toggle-auto" class="ly-btn-main">自動偵測：關</button>
                <button id="btn-clear" class="ly-btn-sub">重置</button>
            </div>

            <div class="ly-stats-header">
                <div class="ly-stats-title"><div class="ly-dot"></div> 即時數據統計</div>
                <div id="stat-total-label" class="ly-stats-rounds">0 局</div>
            </div>

            <div class="ly-stats-boxes">
                <div class="ly-stat-box box-banker"><span>莊</span><strong id="cnt-banker">0</strong></div>
                <div class="ly-stat-box box-player"><span>閒</span><strong id="cnt-player">0</strong></div>
                <div class="ly-stat-box box-tie"><span>和</span><strong id="cnt-tie">0</strong></div>
            </div>

            <div class="ly-prediction">
                <div class="ly-pred-header">
                    <div class="ly-pred-title">下局推薦方向</div>
                    <div id="active-strategy-tag" class="ly-pred-badge" style="border-color:var(--border-color); color:var(--text-gray);">等待開局</div>
                </div>

                <div class="ly-target-area">
                    <div class="ly-target-label">模型綜合判斷</div>
                    <div id="rec-target" class="ly-target-value color-neutral">【 準備中 】</div>
                </div>

                <div class="ly-rate-row">
                    <span>近期預測勝率</span>
                    <span id="stat-all-rate" class="ly-rate-val">0%</span>
                </div>

                <div class="ly-metrics">
                    <div class="ly-metric">勝 <strong id="stat-wins">0</strong></div>
                    <div class="ly-metric">敗 <strong id="stat-losses">0</strong></div>
                    <div class="ly-metric">和 <strong id="stat-pushes">0</strong></div>
                </div>

                <div class="ly-footer">
                    <span id="stat-streak-tag" class="ly-footer-streak">連勝 0</span>
                    <span id="status-text">即時精算中</span>
                </div>

                <div class="ly-autobet-row">
                    <div class="ly-autobet-toggle-group">
                        <span class="ly-autobet-label">自動下注</span>
                        <button id="btn-toggle-autobet" class="ly-autobet-switch" aria-pressed="false" type="button">OFF</button>
                    </div>
                    <div class="ly-autobet-toggle-group">
                        <span class="ly-autobet-label">倍投</span>
                        <button id="btn-toggle-martingale" class="ly-autobet-switch" aria-pressed="false" type="button">OFF</button>
                    </div>
                    <div class="ly-autobet-amount-group">
                        <span class="ly-autobet-label">金額</span>
                        <input id="input-autobet-amount" class="ly-autobet-input" type="number" min="100" max="5000" step="100" value="100" inputmode="numeric" />
                    </div>
                    <span id="lyt-watermark" class="ly-watermark ly-watermark-row" title="長期戰績" role="button" tabindex="0">【龍盈技術團隊】</span>
                </div>

                <div id="backtest-panel-wrapper" class="ly-backtest-wrapper is-collapsed">
                    <div id="backtest-gate" class="ly-backtest-gate">
                        <div class="ly-backtest-gate-label">🔒 請輸入密碼以查看長期戰績</div>
                        <div class="ly-backtest-gate-row">
                            <input id="bt-password-input" type="password" class="ly-backtest-pass-input" placeholder="請輸入密碼" autocomplete="off" />
                            <button id="btn-bt-unlock" class="ly-backtest-btn" type="button">解鎖</button>
                        </div>
                        <div id="bt-password-error" class="ly-backtest-pass-error"></div>
                    </div>
                    <div id="backtest-card" class="ly-backtest-card" style="display:none;">
                        <div class="ly-backtest-header">
                            <div class="ly-backtest-title"><div class="ly-dot"></div> 長期戰績（自動收集）</div>
                            <button id="btn-refresh-backtest" class="ly-backtest-btn" type="button">更新戰績</button>
                        </div>
                        <div class="ly-backtest-grid">
                            <div class="ly-backtest-item"><span>累積局數</span><strong id="bt-total">0</strong></div>
                            <div class="ly-backtest-item"><span>命中率</span><strong id="bt-hitrate">--</strong></div>
                            <div class="ly-backtest-item"><span>覆蓋率</span><strong id="bt-coverage">--</strong></div>
                            <div class="ly-backtest-item"><span>最長連敗</span><strong id="bt-streak">0</strong></div>
                        </div>
                        <div class="ly-backtest-baseline">
                            <div><span>隨機基準</span><b>49.3%</b></div>
                            <div><span>全押莊</span><b>50.7%</b></div>
                            <div><span>本模型</span><b id="bt-model-rate" class="is-model">--</b></div>
                        </div>
                        <div id="bt-sub" class="ly-backtest-sub"></div>
                        <div id="bt-status" class="ly-backtest-status">尚未計算，點擊「更新戰績」查看目前累積的真實回測結果</div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(container);
        if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches) { panelScale = 0.85; container.style.transform = 'translate3d(0, 0, 0) scale(0.85)'; }

        let currentX = 0, currentY = 0, initialX = 0, initialY = 0, xOffset = 0, yOffset = 0;
        (function initDraggable() {
            const header = container.querySelector('#panel-header');
            let isDragging = false, activePointerId = null;
            const applyPosition = () => { container.style.transform = 'translate3d(' + currentX + 'px, ' + currentY + 'px, 0) scale(' + panelScale + ')'; };
            const begin = (clientX, clientY, event) => { if (event.target.closest('button')) return; initialX = clientX - xOffset; initialY = clientY - yOffset; isDragging = true; event.preventDefault(); };
            const move = (clientX, clientY, event) => { if (!isDragging) return; event.preventDefault(); currentX = clientX - initialX; currentY = clientY - initialY; xOffset = currentX; yOffset = currentY; applyPosition(); };
            const end = () => { initialX = currentX; initialY = currentY; activePointerId = null; isDragging = false; };
            header.addEventListener('pointerdown', event => { activePointerId = event.pointerId; begin(event.clientX, event.clientY, event); if (isDragging && header.setPointerCapture) header.setPointerCapture(activePointerId); });
            header.addEventListener('pointermove', event => { if (event.pointerId === activePointerId) move(event.clientX, event.clientY, event); });
            header.addEventListener('pointerup', end); header.addEventListener('pointercancel', end);
            header.addEventListener('touchstart', event => { const touch = event.touches[0]; if (touch) begin(touch.clientX, touch.clientY, event); }, { passive: false });
            header.addEventListener('touchmove', event => { const touch = event.touches[0]; if (touch) move(touch.clientX, touch.clientY, event); }, { passive: false });
            header.addEventListener('touchend', end, { passive: true }); header.addEventListener('touchcancel', end, { passive: true });
        })();

        document.getElementById('btn-zoom-in').onclick = (e) => { e.stopPropagation(); if (panelScale < 1.5) { panelScale = Math.round((panelScale + 0.1)*10)/10; syncPanelZoomUi(); } };
        document.getElementById('btn-zoom-out').onclick = (e) => { e.stopPropagation(); if (panelScale > 0.6) { panelScale = Math.round((panelScale - 0.1)*10)/10; syncPanelZoomUi(); } };

        // 【獨立擴充】縮放同步函式：與既有 +/- 按鈕共用同一個 panelScale 狀態變數與
        // container.style.transform（translate3d 保留拖曳位移，scale 沿用 panelScale）。
        function syncPanelZoomUi() {
            const percentText = `${Math.round(panelScale * 100)}%`;
            const zoomLabel = document.getElementById('label-zoom-level');
            if (zoomLabel) zoomLabel.innerText = percentText;
            container.style.transform = `translate3d(${currentX}px, ${currentY}px, 0) scale(${panelScale})`;
        }

        function updateHeaderTime() {
            const now = new Date();
            document.getElementById('header-time-line').innerText = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
        }

        // 莊／閒／和的中英與繁簡標籤變體，涵蓋手機版可能使用的不同文案。
        const SCORE_LABEL_VARIANTS = Object.freeze({
            banker: ['莊', '庄', 'Banker', 'BANKER'],
            player: ['閒', '闲', 'Player', 'PLAYER'],
            tie: ['和', 'Tie', 'TIE']
        });
        const buildScoreRegex = () => {
            const b = SCORE_LABEL_VARIANTS.banker.join('|');
            const p = SCORE_LABEL_VARIANTS.player.join('|');
            const t = SCORE_LABEL_VARIANTS.tie.join('|');
            return new RegExp(`(?:${b})\\s*[:：]?\\s*(\\d+)\\D*?(?:${p})\\s*[:：]?\\s*(\\d+)\\D*?(?:${t})\\s*[:：]?\\s*(\\d+)`);
        };
        const SCORE_TEXT_PATTERN = buildScoreRegex();
        // 遞迴走訪 DOM 與已開放（open）的 Shadow Root，因手機版網頁常使用 Shadow DOM 封裝節點。
        function collectCandidateElements(root, results = [], visited = new Set()) {
            if (!root || visited.has(root)) return results;
            visited.add(root);
            try {
                const elements = root.querySelectorAll ? root.querySelectorAll('div, span, p, td, li, section') : [];
                elements.forEach(el => {
                    results.push(el);
                    if (el.shadowRoot) collectCandidateElements(el.shadowRoot, results, visited);
                });
            } catch (error) { safeDebug('[MT Baccarat] DOM 掃描失敗', error); }
            return results;
        }
        function fetchScores() {
            const normalizeText = (el) => {
                if (!el) return '';
                // innerText 在部分手機瀏覽器對隱藏或跨行節點解析不穩定，改用 textContent 並清除多餘空白。
                const raw = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                return raw;
            };
            const parseScoreElement = (el) => {
                if (!el || container.contains(el)) return null;
                const text = normalizeText(el);
                if (!text || text.length > 200) return null;
                const match = text.match(SCORE_TEXT_PATTERN);
                if (!match) return null;
                const scores = { b: parseInt(match[1], 10), p: parseInt(match[2], 10), t: parseInt(match[3], 10) };
                return [scores.b, scores.p, scores.t].every(Number.isInteger) ? scores : null;
            };
            const cachedScores = parseScoreElement(scoreElementCache);
            if (cachedScores) return cachedScores;
            scoreElementCache = null;
            const candidates = collectCandidateElements(document);
            for (const el of candidates) {
                const scores = parseScoreElement(el);
                if (scores) {
                    scoreElementCache = el;
                    return scores;
                }
            }
            if (wsLiveScores && [wsLiveScores.b, wsLiveScores.p, wsLiveScores.t].every(Number.isInteger) && [wsLiveScores.b, wsLiveScores.p, wsLiveScores.t].every(value => value >= 0)) return { ...wsLiveScores };
            return null;
        }
        function hasWebSocketRoundFeature() {
            const counts = wsLiveScores || lastLoggedWsCounts;
            return Boolean(counts && [counts.b, counts.p, counts.t].every(Number.isInteger) && [counts.b, counts.p, counts.t].every(value => value >= 0));
        }
        function forceMobileRoomReady() {
            if (!isMobileHost || roomReady) return false;
            roomReady = true;
            toggleBtn.disabled = false;
            toggleBtn.innerText = '自動偵測：關';
            return true;
        }
        function hasValidScoreElement() {
            const candidates = collectCandidateElements(document);
            for (const el of candidates) {
                if (container.contains(el)) continue;
                const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                if (text && text.length <= 200 && SCORE_TEXT_PATTERN.test(text)) return true;
            }
            return false;
        }

        function evaluateHandOutcome(actualOutcome) {
            if (!pendingPrediction) return;
            const prediction = pendingPrediction;
            pendingPrediction = null;
            const isShadowPrediction = Boolean(prediction.isShadow || shadowMode);
            const status = prediction.target === null ? 'abstain' : actualOutcome === '和' ? 'push' : actualOutcome === prediction.target ? 'win' : 'loss';
            const roadState = getSafeRoadSummary(prediction.history);
            const previousStrategyLossStreak = strategyLossStreak;
            // 【修正】倍投結算必須與 notifyAutoBetOnPrediction() 實際下注的觸發條件完全一致
            // （autoDetectEnabled、!isShadowPrediction、autoBetEnabled、isReal），否則在
            // 「未真正下注」的情況下（例如 Shadow Betting 模擬觀望期間）金額仍會被錯誤翻倍
            // 或重置，導致倍投序列被打亂（例如出現不規則的 100→200→300）。
            const wasActuallyBetThisRound = autoDetectEnabled && autoBetEnabled && !isShadowPrediction && prediction.isReal && (prediction.target === '莊' || prediction.target === '閒');
            if (martingaleEnabled && wasActuallyBetThisRound) {
                if (status === 'loss') {
                    martingaleAmount = Math.min(50000, Math.max(autoBetAmount, martingaleAmount * 2));
                } else if (status === 'win') {
                    martingaleAmount = autoBetAmount;
                }
                console.log(`[自動下注][倍投] 本局${status === 'loss' ? '輸局' : status === 'win' ? '贏局' : '和局'}，下一局金額：${martingaleAmount} 元`);
            }
            if (!isShadowPrediction) {
                updateModelPerformance(prediction, actualOutcome);
                if (status === 'loss') strategyLossStreak++; else if (status === 'win' || status === 'push') strategyLossStreak = 0;
                if (prediction.isReal && status === 'win') currentStreak++;
                if (prediction.isReal && status === 'loss') currentStreak = 0;
                if (prediction.isReal && status === 'loss' && strategyLossStreak >= ULTIMATE_CONFIG.SHADOW_TRIGGER_LOSSES) shadowMode = true;
            } else if (status === 'win' || status === 'loss') {
                if (status === 'win') { shadowWins++; shadowSuccessStreak++; } else { shadowLosses++; shadowSuccessStreak = 0; }
                const shadowSettled = shadowWins + shadowLosses;
                const shadowRate = shadowSettled > 0 ? shadowWins / shadowSettled : 0;
                if (shadowRate >= ULTIMATE_CONFIG.SHADOW_MIN_WIN_RATE && shadowSuccessStreak >= ULTIMATE_CONFIG.SHADOW_RECOVERY_STREAK) {
                    shadowMode = false; shadowWins = 0; shadowLosses = 0; shadowSuccessStreak = 0; strategyLossStreak = 0;
                }
            }
            predictionRecords.push({ round: prediction.round, history: prediction.history.slice(-MAX_HISTORY), target: prediction.target, isReal: prediction.isReal && !isShadowPrediction, actual: actualOutcome, status, modelVotes: prediction.modelVotes });
            if (predictionRecords.length > MAX_HISTORY) predictionRecords.splice(0, predictionRecords.length - MAX_HISTORY);
            writeDataLog('prediction-result', { round: prediction.round, target: prediction.target, actual: actualOutcome, status, shadow: isShadowPrediction, strategyLossStreak: previousStrategyLossStreak, road: roadState });
        }

        function recordActualRound(outcome, bankerCount, playerCount, tieCount) {
            const record = {
                round: actualRoundHistory.length + 1,
                outcome,
                counts: { banker: bankerCount, player: playerCount, tie: tieCount },
                recordedAt: new Date().toISOString()
            };
            actualRoundHistory.push(record);
            gameSequence.push(outcome);
            // 【自動收集】每局真實結果同步寫入持久化歷史，供 runPersistedBacktest 之類的
            // 離線回測工具使用；即使使用者忘記手動保存，資料也不會因重新整理頁面而消失。
            appendPersistedOutcome(outcome);
            if (actualRoundHistory.length > MAX_HISTORY) actualRoundHistory.splice(0, actualRoundHistory.length - MAX_HISTORY);
            if (gameSequence.length > MAX_HISTORY) gameSequence.splice(0, gameSequence.length - MAX_HISTORY);
            const roadState = getSafeRoadSummary(gameSequence);
            writeDataLog('new-round', {
                round: record.round,
                outcome,
                counts: record.counts,
                strategyLossStreak,
                road: roadState
            });
        }
        function getPredictionStats(mode = null) {
            const activeRecords = predictionStartRound === null
                ? []
                : predictionRecords.filter(record => record.round >= predictionStartRound);
            const records = mode === null ? activeRecords : activeRecords.filter(record => record.isReal === mode);
            const wins = records.filter(record => record.status === 'win').length, losses = records.filter(record => record.status === 'loss').length, pushes = records.filter(record => record.status === 'push').length;
            const settled = wins + losses;
            return { wins, losses, pushes, settled, hitRatePct: settled > 0 ? Math.round((wins / settled) * 100) : 0 };
        }
        function replayPanelAnimation(element) {
            if (!element) return;
            element.classList.remove('ly-refresh');
            void element.offsetWidth;
            element.classList.add('ly-refresh');
        }
        function renderDirectionOptions(target, statusText) {
            const elTarget = document.getElementById('rec-target');
            replayPanelAnimation(elTarget);
            if (!target) {
                elTarget.className = 'ly-target-value color-neutral';
                elTarget.innerText = `【 ${statusText} 】`;
                return;
            }
            elTarget.className = 'ly-target-value';
            elTarget.innerHTML = `
                <span class="ly-direction-option is-banker${target === '莊' ? ' is-active' : ''}">【莊】</span>
                <span class="ly-direction-option is-player${target === '閒' ? ' is-active' : ''}">【閒】</span>
            `;
        }
        // 【獨立擴充】notifyAutoBetOnPrediction — 自動下注觸發判斷（旁路監聽，純讀取）
        // ------------------------------------------------------------------------------
        // 本函式只讀取既有 prediction 結果與既有狀態變數（autoBetEnabled、shadowMode、
        // roundNumber、pendingPrediction.round），完全不修改、不覆寫任何核心計算結果、
        // 注碼策略或持久化日誌（persistDataLog/writeDataLog）。
        // 觸發條件（三者缺一不可）：
        //   1. autoBetEnabled 為 true（使用者已手動開啟自動下注開關）
        //   2. prediction.target 為 '莊' 或 '閒'，且 prediction.isReal === true
        //      （核心模型判定為可執行訊號，而非僅供參考的觀望/資料收集訊號）
        //   3. 目前不處於 Shadow Betting Mode（策略模擬觀望期間一律抑制觸發）
        // 並透過 lastAutoBetRound 確保同一局只觸發一次，避免同一筆預測被重複印出模擬下注。
        // 全程包在 try-catch，任何例外只記錄除錯訊息，絕不阻斷 updateCountsAndPredict 主流程。
        function notifyAutoBetOnPrediction(prediction) {
            try {
                // 【除錯輔助】只要有明確方向（isReal）但因故被抑制，一律印出「為什麼沒有觸發」，
                // 方便使用者在 Console 直接確認目前四個關卡各自的狀態，不需要再逐一猜測。
                const hasDirectionalSignal = prediction && prediction.isReal && (prediction.target === '莊' || prediction.target === '閒');
                if (hasDirectionalSignal && !(autoDetectEnabled && autoBetEnabled && !shadowMode)) {
                    console.log(`[自動下注][除錯] 偵測到明確方向【${prediction.target}】但未觸發下注：autoDetectEnabled=${autoDetectEnabled}、autoBetEnabled=${autoBetEnabled}、shadowMode=${shadowMode}`);
                }
                if (!autoDetectEnabled || !autoBetEnabled) return;
                if (shadowMode) return;
                if (!prediction || !prediction.isReal) return;
                if (prediction.target !== '莊' && prediction.target !== '閒') return;

                const currentRound = roundNumber + 1;
                if (lastAutoBetRound === currentRound) return; // 同一局已觸發過，避免重複下注日誌
                lastAutoBetRound = currentRound;

                const stakeAmount = martingaleEnabled ? martingaleAmount : autoBetAmount;
                if (window.MTAutoBetManager && typeof window.MTAutoBetManager.placeRealBet === 'function') {
                    console.log(`[自動下注] 偵測已開啟，方向【${prediction.target}】，實際下注金額：${stakeAmount} 元${martingaleEnabled ? '（倍投）' : ''}`);
                    window.MTAutoBetManager.placeRealBet(prediction.target, stakeAmount);
                }
            } catch (error) {
                safeDebug('[自動下注] 觸發判斷發生例外，已安全略過：', error);
            }
        }

        function updateCountsAndPredict(b, p, t, shouldPredict = true) {
            const total = b + p + t;
            document.getElementById('cnt-banker').innerText = b; document.getElementById('cnt-player').innerText = p; document.getElementById('cnt-tie').innerText = t;
            ['cnt-banker', 'cnt-player', 'cnt-tie'].forEach(id => replayPanelAnimation(document.getElementById(id)));
            document.getElementById('stat-total-label').innerText = `${b + p + t} 局`; updateHeaderTime();
            const allStats = getPredictionStats();
            document.getElementById('stat-wins').innerText = allStats.wins; document.getElementById('stat-losses').innerText = allStats.losses; document.getElementById('stat-pushes').innerText = allStats.pushes;
            document.getElementById('stat-all-rate').innerText = `${allStats.hitRatePct}%`; document.getElementById('stat-streak-tag').innerText = `連勝 ${currentStreak}`;
            replayPanelAnimation(document.getElementById('stat-all-rate'));

            const elTarget = document.getElementById('rec-target'), tagStrategy = document.getElementById('active-strategy-tag');

            if (total === 0) {
                renderDirectionOptions(null, '準備中');
                tagStrategy.style.borderColor = 'rgba(255, 255, 255, 0.08)'; tagStrategy.style.color = '#8b8d96'; tagStrategy.innerText = '等待開局';
                return;
            }

            if (!shouldPredict) return;
            if (observationRounds < OBSERVATION_ROUNDS) {
                pendingPrediction = null;
                renderDirectionOptions(null, `觀望 ${OBSERVATION_ROUNDS - observationRounds} 把`);
                tagStrategy.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                tagStrategy.style.color = '#8b8d96';
                tagStrategy.innerText = '觀察期';
                return;
            }
            const prediction = applyAuxiliaryRoadEnhancement(
                getEnsemblePrediction(gameSequence, predictionRecords),
                gameSequence
            );
            if (predictionStartRound === null) predictionStartRound = roundNumber + 1;
            pendingPrediction = { ...prediction, isShadow: shadowMode, round: roundNumber + 1, history: [...gameSequence] };

            if (shadowMode) {
                renderDirectionOptions(null, '策略模擬中，建議觀望');
                tagStrategy.style.borderColor = '#8b8d96'; tagStrategy.style.color = '#8b8d96'; tagStrategy.innerText = 'Shadow Betting';
                return;
            }

            if (!prediction.target) {
                renderDirectionOptions(null, prediction.mode === '資料收集中' ? '資料收集中' : '觀望');
                tagStrategy.style.borderColor = 'rgba(255, 255, 255, 0.08)'; tagStrategy.style.color = '#8b8d96'; tagStrategy.innerText = prediction.mode;
                return;
            }

            renderDirectionOptions(prediction.target, prediction.mode);
            notifyAutoBetOnPrediction(prediction);

            if (prediction.isReal) {
                tagStrategy.style.borderColor = '#d4af37'; tagStrategy.style.color = '#d4af37'; tagStrategy.innerText = prediction.mode;
            } else {
                tagStrategy.style.borderColor = 'rgba(255, 255, 255, 0.08)'; tagStrategy.style.color = '#8b8d96'; tagStrategy.innerText = prediction.mode;
            }
        }
        function resetPredictionSession() { gameSequence = []; actualRoundHistory = []; predictionRecords = []; pendingPrediction = null; roundNumber = 0; predictionStartRound = null; currentStreak = 0; observationRounds = 0; strategyLossStreak = 0; shadowMode = false; shadowWins = 0; shadowLosses = 0; shadowSuccessStreak = 0; modelPerformance = Object.create(null); }
        function disconnectRoomObserver() {
            if (!roomObserver) return;
            roomObserver.disconnect();
            roomObserver = null;
        }
        function stopEngineScanner() {
            scannerGeneration++;
            if (headerTimeTimer !== null) {
                clearInterval(headerTimeTimer);
                headerTimeTimer = null;
            }
            if (scanTimer !== null) {
                clearInterval(scanTimer);
                scanTimer = null;
            }
        }
        function resetRoomState() {
            autoDetectEnabled = false;
            roomReady = false;
            lastB = -1; lastP = -1; lastT = -1;
            resetPredictionSession();
            wsLiveScores = null;
            lastLoggedWsCounts = null;
            scoreElementCache = null;
            toggleBtn.disabled = true;
            toggleBtn.classList.remove('is-active');
            toggleBtn.style.color = '';
            toggleBtn.style.background = '';
            toggleBtn.innerText = '進房後可啟用';
            updateCountsAndPredict(0, 0, 0, false);
        }
        function startEngineScanner() {
            if (scanTimer !== null) return;
            const generation = scannerGeneration;
            scannerStartedAt = Date.now();
            headerTimeTimer = setInterval(updateHeaderTime, ULTIMATE_CONFIG.HEADER_TIME_INTERVAL_MS);
            scanTimer = setInterval(() => {
                if (generation !== scannerGeneration || !container.parentNode) {
                    stopEngineScanner();
                    return;
                }
                if (!isAuthorizationValid()) {
                    stopEngineScanner();
                    disconnectRoomObserver();
                    if (container.parentNode) container.remove();
                    showExpiredModal();
                    autoDetectEnabled = false;
                    return;
                }
                const mobileElapsed = isMobileHost && scannerStartedAt > 0 ? Date.now() - scannerStartedAt : 0;
                if (isMobileHost && (hasWebSocketRoundFeature() || mobileElapsed >= MOBILE_ROOM_READY_DELAY_MS)) forceMobileRoomReady();
                const scores = fetchScores() || (isMobileHost && hasWebSocketRoundFeature() ? wsLiveScores : null);
                if (!scores) {
                    if (isMobileHost) return;
                    resetRoomState();
                    stopEngineScanner();
                    return;
                }
                const { b, p, t } = scores;
                if (!scores || !Object.prototype.hasOwnProperty.call(scores, 'b') || !Object.prototype.hasOwnProperty.call(scores, 'p') || !Object.prototype.hasOwnProperty.call(scores, 't')) {
                    if (isMobileHost) return;
                    resetRoomState(); stopEngineScanner(); return;
                }
                if (![b, p, t].every(Number.isInteger) || [b, p, t].some(value => value < 0)) {
                    resetRoomState();
                    stopEngineScanner();
                    return;
                }
                if (!roomReady) {
                    roomReady = true;
                    toggleBtn.disabled = false;
                    toggleBtn.innerText = '自動偵測：關';
                }
                if (!autoDetectEnabled) return;
                if (lastB !== -1 && lastP !== -1) {
                    const countersReset = b < lastB || p < lastP || t < lastT;
                    if (countersReset) { resetPredictionSession(); lastB = b; lastP = p; lastT = t; updateCountsAndPredict(b, p, t); return; }
                    const bankerDelta = b - lastB, playerDelta = p - lastP, tieDelta = t - lastT;
                    const changedCounters = [bankerDelta, playerDelta, tieDelta].filter(delta => delta > 0).length, hasNewRound = bankerDelta > 0 || playerDelta > 0 || tieDelta > 0;
                    if (hasNewRound && changedCounters === 1) {
                        const actual = bankerDelta > 0 ? '莊' : playerDelta > 0 ? '閒' : '和';
                        recordActualRound(actual, b, p, t);
                        evaluateHandOutcome(actual);
                        observationRounds = Math.min(OBSERVATION_ROUNDS, observationRounds + 1);
                        roundNumber++; lastB = b; lastP = p; lastT = t; updateCountsAndPredict(b, p, t);
                    } else if (b !== lastB || p !== lastP || t !== lastT) { lastB = b; lastP = p; lastT = t; updateCountsAndPredict(b, p, t, false); }
                } else { gameSequence = []; actualRoundHistory = []; lastB = b; lastP = p; lastT = t; updateCountsAndPredict(b, p, t); }
            }, CONFIG.SCAN_INTERVAL);
        }

        const toggleBtn = document.getElementById('btn-toggle-auto');
        toggleBtn.disabled = true;
        toggleBtn.innerText = '進房後可啟用';
        const observeRoom = () => {
            disconnectRoomObserver();
            const observer = new MutationObserver(() => {
                if (roomObserver !== observer || !isAuthorizationValid() || !container.parentNode) return;
                if (scanTimer === null && hasValidScoreElement()) startEngineScanner();
            });
            roomObserver = observer;
            return observer;
        };
        const observer = observeRoom();
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        toggleBtn.onclick = () => {
            if (!roomReady) return;
            autoDetectEnabled = !autoDetectEnabled;
            if (autoDetectEnabled) {
                toggleBtn.innerText = '自動偵測：開'; toggleBtn.classList.add('is-active');
                toggleBtn.style.color = ''; toggleBtn.style.background = '';
                lastB = -1; lastP = -1; lastT = -1; resetPredictionSession(); wsLiveScores = null; lastLoggedWsCounts = null; scoreElementCache = null;
                // 【修正】重新開啟自動偵測時同步重設 lastAutoBetRound，避免沿用上一次偵測
                // 時已觸發過的局號，導致重啟後第一局明明有明確方向卻被誤判為「已觸發過」而不下注。
                lastAutoBetRound = null;
            } else {
                toggleBtn.innerText = '自動偵測：關'; toggleBtn.classList.remove('is-active');
                toggleBtn.style.color = ''; toggleBtn.style.background = '';
            }
        };
        document.getElementById('btn-clear').onclick = () => { lastB = -1; lastP = -1; lastT = -1; resetPredictionSession(); wsLiveScores = null; lastLoggedWsCounts = null; scoreElementCache = null; lastAutoBetRound = null; updateCountsAndPredict(0, 0, 0); };

        // 【獨立擴充】長期戰績面板：浮水印觸發 + 密碼閘門
        // ------------------------------------------------------------------------------
        // 設計原則：
        // 1. 面板預設「收合」（class is-collapsed），只在金額輸入框旁顯示一個低調的
        //    【龍盈技術團隊】浮水印標籤，不佔用版面、不影響一般使用者操作。
        // 2. 點擊浮水印展開時，若本次頁面尚未解鎖過，一律先顯示密碼閘門（#backtest-gate），
        //    輸入正確密碼才會顯示原本的戰績卡片內容；密碼僅為簡單字串比對（軟性門檻，
        //    因原始碼本身可被檢視，非高安全性加密機制，僅用於防止一般使用者誤觸/誤看）。
        // 3. isBacktestUnlocked 僅存在於記憶體（此次 initCoreEngine 呼叫的閉包內），
        //    不做任何 localStorage/sessionStorage 持久化：重新整理頁面必定重置為未解鎖，
        //    符合「同一次頁面開啟期間解鎖一次即可、重整後需再次輸入」的需求。
        // 4. 收合／展開動作本身不影響 isBacktestUnlocked：已解鎖時，收合後再次展開會
        //    直接顯示戰績卡片，不會被要求重新輸入密碼。
        let isBacktestUnlocked = false;
        const LONG_TERM_PANEL_PASSWORD = '3.1415926uamlus';

        const watermarkTrigger = document.getElementById('lyt-watermark');
        const backtestWrapper = document.getElementById('backtest-panel-wrapper');
        const backtestGate = document.getElementById('backtest-gate');
        const backtestCardElem = document.getElementById('backtest-card');
        const btPasswordInput = document.getElementById('bt-password-input');
        const btPasswordError = document.getElementById('bt-password-error');
        const btnBtUnlock = document.getElementById('btn-bt-unlock');

        // 依目前解鎖狀態，切換顯示「密碼閘門」或「戰績卡片」（不改變收合/展開狀態本身）
        function refreshBacktestGateVisibility() {
            if (!backtestGate || !backtestCardElem) return;
            if (isBacktestUnlocked) {
                backtestGate.style.display = 'none';
                backtestCardElem.style.display = '';
            } else {
                backtestGate.style.display = '';
                backtestCardElem.style.display = 'none';
            }
        }

        if (watermarkTrigger && backtestWrapper) {
            watermarkTrigger.onclick = () => {
                try {
                    const isCurrentlyCollapsed = backtestWrapper.classList.contains('is-collapsed');
                    if (isCurrentlyCollapsed) {
                        // 展開前先依解鎖狀態決定顯示密碼閘門或戰績卡片
                        refreshBacktestGateVisibility();
                        backtestWrapper.classList.remove('is-collapsed');
                        // 若尚未解鎖，展開後把焦點移到密碼輸入框，方便使用者直接輸入
                        if (!isBacktestUnlocked && btPasswordInput) {
                            setTimeout(() => { try { btPasswordInput.focus(); } catch (e) { /* 靜默失敗 */ } }, 50);
                        }
                    } else {
                        // 收合不影響 isBacktestUnlocked，下次展開若已解鎖仍會直接顯示戰績卡片
                        backtestWrapper.classList.add('is-collapsed');
                    }
                } catch (error) {
                    safeDebug('[MT Baccarat] 長期戰績面板展開/收合失敗', error);
                }
            };
        }

        // 執行密碼比對：正確則解鎖並顯示戰績卡片；錯誤則顯示提示並觸發 shake 動畫
        function attemptBacktestUnlock() {
            try {
                if (!btPasswordInput) return;
                const inputValue = String(btPasswordInput.value || '');
                if (inputValue === LONG_TERM_PANEL_PASSWORD) {
                    isBacktestUnlocked = true;
                    if (btPasswordError) btPasswordError.innerText = '';
                    btPasswordInput.value = '';
                    refreshBacktestGateVisibility();
                } else {
                    if (btPasswordError) btPasswordError.innerText = '密碼錯誤，請再試一次';
                    btPasswordInput.value = '';
                    if (backtestGate) {
                        backtestGate.classList.remove('is-shake');
                        // 強制觸發 reflow，讓 class 移除後重新加入時動畫能重新播放
                        void backtestGate.offsetWidth;
                        backtestGate.classList.add('is-shake');
                        setTimeout(() => { try { backtestGate.classList.remove('is-shake'); } catch (e) { /* 靜默失敗 */ } }, 450);
                    }
                    try { btPasswordInput.focus(); } catch (e) { /* 靜默失敗 */ }
                }
            } catch (error) {
                safeDebug('[MT Baccarat] 長期戰績密碼解鎖流程發生例外', error);
            }
        }

        if (btnBtUnlock) { btnBtUnlock.onclick = attemptBacktestUnlock; }
        if (btPasswordInput) {
            btPasswordInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') { attemptBacktestUnlock(); }
            });
        }

        // 【獨立擴充】長期戰績小卡片：「更新戰績」按鈕事件繫結
        // ------------------------------------------------------------------------------
        // 設計原則：runPersistedBacktest() 需要對累積歷史（最多 3000 局）逐局重播回測，
        // 運算量較大，若在點擊當下同步執行會讓瀏覽器主執行緒卡住、UI 凍結。
        // 因此採「先切換按鈕為運算中狀態 → setTimeout(fn, 0) 延後一個事件循環 → 執行實際運算」
        // 的模式，讓瀏覽器有機會先重繪出「運算中...」的畫面，改善使用者體感。
        // 全程包裹 try-catch，確保任何例外都不會讓按鈕卡死在「運算中」而永久失效。
        const btnRefreshBacktest = document.getElementById('btn-refresh-backtest');
        const btStatusElem = document.getElementById('bt-status');
        if (btnRefreshBacktest && btStatusElem) {
            btnRefreshBacktest.onclick = () => {
                btnRefreshBacktest.disabled = true;
                btnRefreshBacktest.innerText = '運算中...';
                btStatusElem.classList.remove('is-warn');
                btStatusElem.innerText = '正在重播累積歷史局數，請稍候...';

                // 用 setTimeout(0) 讓瀏覽器先完成一次重繪，再執行耗時的回測運算
                setTimeout(() => {
                    try {
                        const report = runPersistedBacktest();
                        renderBacktestReport(report);
                    } catch (err) {
                        // 任何未預期例外一律降級為安全提示，不影響主流程也不讓按鈕卡死
                        btStatusElem.classList.add('is-warn');
                        btStatusElem.innerText = '計算發生錯誤，請稍後再試（' + (err && err.message ? err.message : '未知錯誤') + '）';
                    } finally {
                        btnRefreshBacktest.disabled = false;
                        btnRefreshBacktest.innerText = '更新戰績';
                    }
                }, 0);
            };
        }

        // 將回測報告格式化並寫入小卡片對應的 DOM 元素
        // 邊界條件：totalRounds 為 0、hitRate/coverage 為 null（樣本不足）等情況
        // 均需優雅降級顯示「--」，避免出現 NaN% 或 undefined 等破版文字。
        //
        // 【顯示口徑說明】
        // 主命中率採用「全部實際推薦」的成績，因為面板只要顯示了方向，使用者就可能跟單，
        // 那才是真正反映「跟著面板走會怎樣」的數字。
        //
        // 註：離線實測（20 組 × 484 局）顯示，被標記為「真實訊號」（isReal）的局次
        // 命中率 49.89%，反而略低於「參考方向」的 51.48%。這代表目前的訊號篩選門檻
        // （高熵防禦、分歧觀望、margin/agreement 門檻）並不具備辨識能力，
        // 因此不適合拿 isReal 當作主要績效指標，兩者改於下方小字分開揭露供對照。
        //
        // 【為什麼要顯示誤差範圍】
        // 命中率是抽樣統計量，樣本數越少波動越大。以 400 次下注為例，
        // 即使真實命中率剛好是 50%，單次觀測有 95% 機率落在約 45% ~ 55% 之間。
        // 不標示誤差範圍，使用者很容易把正常的隨機波動誤判為「系統壞掉」。
        function renderBacktestReport(report) {
            const totalElem = document.getElementById('bt-total');
            const hitRateElem = document.getElementById('bt-hitrate');
            const coverageElem = document.getElementById('bt-coverage');
            const streakElem = document.getElementById('bt-streak');
            const modelRateElem = document.getElementById('bt-model-rate');
            const subElem = document.getElementById('bt-sub');
            if (!totalElem || !hitRateElem || !coverageElem || !streakElem) { return; }

            const formatPercent = (value) => (typeof value === 'number' && isFinite(value)) ? (value * 100).toFixed(1) + '%' : '--';

            const totalRounds = (report && typeof report.totalRounds === 'number') ? report.totalRounds : 0;
            // signals = wins + losses，代表模型實際發出「方向性預測」的總次數（不含棄權/和局）
            const totalSignals = (report && typeof report.signals === 'number') ? report.signals : 0;
            const realSignals = (report && typeof report.realSignals === 'number') ? report.realSignals : 0;
            const realHitRate = report && typeof report.realHitRate === 'number' ? report.realHitRate : null;
            const referenceSignals = (report && typeof report.referenceSignals === 'number') ? report.referenceSignals : 0;
            const referenceHitRate = report && typeof report.referenceHitRate === 'number' ? report.referenceHitRate : null;
            const primaryHitRate = report && typeof report.hitRate === 'number' ? report.hitRate : null;
            const primarySignals = totalSignals;

            // 95% 信賴區間半寬 ≈ 1.96 × √(p(1-p)/n)，即「這個數字的合理誤差範圍」。
            const marginOfError = (primarySignals > 0 && typeof primaryHitRate === 'number' && isFinite(primaryHitRate))
                ? 1.96 * Math.sqrt(Math.max(primaryHitRate * (1 - primaryHitRate), 0.0001) / primarySignals)
                : null;

            totalElem.innerText = String(totalRounds);
            hitRateElem.innerText = (typeof primaryHitRate === 'number' && isFinite(primaryHitRate) && marginOfError !== null)
                ? `${(primaryHitRate * 100).toFixed(1)}% ±${(marginOfError * 100).toFixed(1)}`
                : formatPercent(primaryHitRate);
            coverageElem.innerText = formatPercent(report && report.coverage);
            streakElem.innerText = String((report && typeof report.longestLossStreak === 'number') ? report.longestLossStreak : 0);

            // 基準線對照：與「一律押莊」的 50.68% 數學基準比較，超過才標綠、明顯落後才標紅。
            if (modelRateElem) {
                modelRateElem.innerText = formatPercent(primaryHitRate);
                modelRateElem.classList.remove('is-above', 'is-below');
                if (typeof primaryHitRate === 'number' && isFinite(primaryHitRate) && marginOfError !== null) {
                    if (primaryHitRate - marginOfError > 0.5068) { modelRateElem.classList.add('is-above'); }
                    else if (primaryHitRate + marginOfError < 0.4932) { modelRateElem.classList.add('is-below'); }
                }
            }

            if (subElem) {
                const realText = realSignals > 0 ? `真實訊號 ${formatPercent(realHitRate)}（${realSignals} 次）` : '真實訊號 --';
                const refText = referenceSignals > 0 ? `參考方向 ${formatPercent(referenceHitRate)}（${referenceSignals} 次）` : '參考方向 --';
                const tiltText = (report && typeof report.bankerTiltCount === 'number' && report.bankerTiltCount > 0)
                    ? `　莊向偏好修正 ${report.bankerTiltCount} 次` : '';
                subElem.innerText = `${realText}　${refText}${tiltText}`;
            }

            if (!btStatusElem) { return; }
            if (totalRounds < 30) {
                btStatusElem.classList.add('is-warn');
                btStatusElem.innerText = `目前僅累積 ${totalRounds} 局，樣本數過少，命中率僅供參考（建議累積 100 局以上再評估）`;
            } else if (marginOfError !== null && marginOfError > 0.02) {
                // 誤差半寬大於 2% 時，觀測值與基準線的差距很可能只是隨機波動，必須明確提醒。
                const needed = Math.ceil(0.9604 / (0.02 * 0.02));
                btStatusElem.classList.add('is-warn');
                btStatusElem.innerText = `已回測 ${totalRounds} 局、實際預測 ${primarySignals} 次，統計誤差約 ±${(marginOfError * 100).toFixed(1)}%。此範圍內的高低起伏多為隨機波動，需累積約 ${needed} 次預測才能判斷模型是否真的優於基準（非保證性描述）`;
            } else {
                btStatusElem.classList.remove('is-warn');
                btStatusElem.innerText = `已回測 ${totalRounds} 局，實際發出預測 ${primarySignals} 次（更新時間：${new Date().toLocaleTimeString()}）`;
            }
        }

        // 【獨立擴充】自動下注開關 / 金額輸入框事件繫結
        // ------------------------------------------------------------------------------
        // 完全獨立於既有 autoDetectEnabled / roomReady 狀態，開關狀態不受重置局勢
        // （resetPredictionSession）影響，也不做任何持久化（每次重新載入頁面固定為 OFF/100）。

        // 【三層防呆驗證】下注金額輸入框：上下限（100~5000）、百位單位（100 的倍數）、
        // 非法輸入自動修正。任何非數字、空值、超出範圍或非百位倍數的輸入，一律安全修正為
        // 最接近的合法金額，避免非法金額流入 placeRealBet 的下注邏輯。
        function sanitizeAutoBetAmount(rawValue) {
            const MIN_AMOUNT = 100;
            const MAX_AMOUNT = 5000;
            const STEP = 100;
            const parsed = Number.parseInt(rawValue, 10);
            // 邊界一：非數字或小於下限（含空值），一律強制重設為最低金額 100。
            if (!Number.isFinite(parsed) || parsed < MIN_AMOUNT) return MIN_AMOUNT;
            // 邊界二：超過上限，一律強制截斷重設為最高金額 5000。
            if (parsed > MAX_AMOUNT) return MAX_AMOUNT;
            // 邊界三：非百位倍數，四捨五入修正為最接近的百位金額，並再次確保落在上下限之內。
            const roundedToHundred = Math.round(parsed / STEP) * STEP;
            return Math.min(MAX_AMOUNT, Math.max(MIN_AMOUNT, roundedToHundred));
        }

        try {
            const autoBetToggleBtn = document.getElementById('btn-toggle-autobet');
            const autoBetAmountInput = document.getElementById('input-autobet-amount');
            if (autoBetToggleBtn) {
                autoBetToggleBtn.onclick = () => {
                    try {
                        autoBetEnabled = !autoBetEnabled;
                        autoBetToggleBtn.setAttribute('aria-pressed', String(autoBetEnabled));
                        if (autoBetEnabled) {
                            autoBetToggleBtn.innerText = 'ON';
                            autoBetToggleBtn.classList.add('is-active');
                            martingaleAmount = autoBetAmount;
                            lastAutoBetRound = null; // 重新開啟時允許立即對目前局勢觸發一次
                            console.log('[自動下注] 已開啟，下注金額：' + autoBetAmount + ' 元（將於偵測到明確方向時自動執行真實下注）');
                        } else {
                            autoBetToggleBtn.innerText = 'OFF';
                            autoBetToggleBtn.classList.remove('is-active');
                            martingaleAmount = autoBetAmount;
                            console.log('[自動下注] 已關閉');
                        }
                    } catch (error) {
                        safeDebug('[自動下注] 切換開關發生例外：', error);
                    }
                };
            }
            const martingaleToggleBtn = document.getElementById('btn-toggle-martingale');
            if (martingaleToggleBtn) {
                martingaleToggleBtn.onclick = () => {
                    try {
                        martingaleEnabled = !martingaleEnabled;
                        martingaleAmount = autoBetAmount;
                        martingaleToggleBtn.setAttribute('aria-pressed', String(martingaleEnabled));
                        martingaleToggleBtn.innerText = martingaleEnabled ? 'ON' : 'OFF';
                        martingaleToggleBtn.classList.toggle('is-active', martingaleEnabled);
                        console.log(`[自動下注][倍投] ${martingaleEnabled ? '已開啟，輸局後下注金額乘二' : '已關閉，恢復使用原始金額'}；目前金額：${martingaleAmount} 元`);
                    } catch (error) {
                        safeDebug('[自動下注] 切換倍投發生例外：', error);
                    }
                };
            }
            if (autoBetAmountInput) {
                const handleAutoBetAmountCorrection = () => {
                    try {
                        autoBetAmount = sanitizeAutoBetAmount(autoBetAmountInput.value);
                        autoBetAmountInput.value = String(autoBetAmount);
                        martingaleAmount = autoBetAmount;
                    } catch (error) {
                        safeDebug('[自動下注] 金額輸入解析發生例外，已回退為預設值：', error);
                        autoBetAmount = 100;
                        autoBetAmountInput.value = '100';
                    }
                };
                // 依需求，於「變更（change）」與「失焦（blur）」時進行完整防呆修正（含強制取整）。
                autoBetAmountInput.addEventListener('change', handleAutoBetAmountCorrection);
                autoBetAmountInput.addEventListener('blur', handleAutoBetAmountCorrection);
                // 【修正金額同步】新增 input 事件即時同步：使用者打字過程中，只要目前輸入是合法
                // 正整數就立即更新 autoBetAmount / martingaleAmount，不強制在輸入中途改寫顯示值
                // （避免游標跳動的不良體驗），完整的邊界修正仍交由 change/blur 處理。
                autoBetAmountInput.addEventListener('input', () => {
                    try {
                        const parsedWhileTyping = Number.parseInt(autoBetAmountInput.value, 10);
                        if (Number.isFinite(parsedWhileTyping) && parsedWhileTyping > 0) {
                            autoBetAmount = parsedWhileTyping;
                            if (!martingaleEnabled) martingaleAmount = autoBetAmount;
                        }
                    } catch (error) {
                        safeDebug('[自動下注] 金額即時同步發生例外，已安全略過：', error);
                    }
                });
            }
        } catch (error) {
            safeDebug('[自動下注] UI 事件繫結發生例外，已安全略過：', error);
        }

        updateHeaderTime(); startEngineScanner();
    }
})();

// ============================================================================
// 【獨立擴充模組】AutoBetManager — 自動下注框架（手機端全套暴力模擬 + 智慧面額拆解 + 精準文字定位版）
// ------------------------------------------------------------------------------
// 本模組與上方主引擎 IIFE 完全獨立，不共用任何私有變數或函式，僅透過 window 全域
// 最小介面（window.MTAutoBetManager）與主引擎溝通：主引擎現正式呼叫 placeRealBet()
// 執行真實點擊下注（simulateBet() 保留供日後測試/除錯使用，主流程已不再呼叫）。
//
// 本版升級重點：
//   1. 跨框架（iframe，含巢狀）全面搜尋：collectSearchRoots() 遞迴收集 document 本身與
//      所有「同源、可存取」的 iframe contentDocument，找不到目標按鈕時自動往每一層搜尋；
//      跨網域 iframe 會拋出例外，安全略過該層，不影響其餘框架。
//   2. 真人模擬按壓 simulatePress()：依序觸發 pointerdown → mousedown → pointerup →
//      mouseup → click 完整事件鏈，模擬手指在觸控螢幕上「壓下並放開」的物理動作，
//      比單純 .click() 更貼近真人操作，提高手機端網頁事件監聽器的觸發成功率。
//   3. 精準文字定位 findPreciseTextElement()：在候選元素中比對 innerText/textContent，
//      必須包含指定關鍵字且不包含排除字樣（例如排除「寶」「對」），並優先選擇文字最短、
//      最貼近葉節點的元素，避免誤觸周圍的龍寶、對子等按鈕。
//   4. 智慧面額拆解 decomposeAmountToChips()：將下注金額由大到小拆解為目前平台既有籌碼
//      面額組合（50000 / 5000 / 500 / 100），依序點擊、每次點擊間隔 150ms，確保手機
//      瀏覽器網頁能順利吃進連續點擊的次數。
//   5. 自動點擊「確定／確認」送出按鈕：籌碼與投注方向點擊完畢後，延遲 300ms 搜尋並點擊
//      頁面（含 iframe 內）文字為「確定」「確認」「下注」或含「✓」的按鈕，完成最終送出。
//   6. 已內建 MAX_BET_AMOUNT（5 萬元）安全閥：任何超過上限的金額，在點擊前一律自動
//      重設為上限值並印出安全警告，防止設定錯誤或程式異常導致金額暴衝。
// ============================================================================
(function () {
    'use strict';

    // 【真實下注選擇器配置】依 F12 抓取到的目標平台實際 DOM 結構定義，集中管理避免魔術字串散落。
    // 如目標平台改版導致選擇器失效，下方邏輯仍會自動退回「精準文字搜尋 fallback」機制，
    // 不會因單一選擇器失效而完全無法下注。
    const BET_SELECTORS = Object.freeze({
        banker: 'li[data-state="zhuang"] .chip-group',
        player: 'li[data-state="free"] .chip-group',
        chips: Object.freeze({
            100: 'div.chip-100',
            500: 'div.chip-500',
            1000: 'div.chip-1000',
            5000: 'div.chip-5000',
            10000: 'div.chip-10000',
            50000: 'div.chip-50000'
        })
    });

    // 籌碼點擊之間的間隔（毫秒）：確保手機瀏覽器網頁能順利吃進連續點擊的次數。
    // 【物理點擊佇列規範】本模組所有「選籌碼→點投注格」之間的排程一律使用 setTimeout，
    // 且間隔不超過 150ms，避免定時器堆疊造成過長延遲、也符合真人連續點擊的操作節奏。
    const CHIP_CLICK_INTERVAL_MS = 150;
    // 點擊籌碼「選取面額」後，延遲多久再開始點擊投注格疊加金額（毫秒），
    // 讓平台網頁有時間反應「目前選取面額」的狀態切換，模擬真人操作節奏。
    // 【已依規範收斂】原為 200ms，收斂為不超過 150ms 的統一節奏。
    const AUTO_BET_CLICK_DELAY_MS = 150;
    // 點擊投注方向後，延遲多久再搜尋並點擊「確定/確認」送出按鈕（毫秒）。
    // 【使用者 DevTools 實測驗證】原為 300ms，經實測平台彈出確認按鈕的實際反應時間後，
    // 調整為 400ms，確保確認鍵完全渲染出來後才嘗試點擊，降低點擊落空的機率。
    const CONFIRM_CLICK_DELAY_MS = 400;
    // 【安全閥】單筆真實下注金額上限。任何超過此上限的金額，在正式點擊前一律自動重設為此值，
    // 並印出安全警告，防止設定錯誤或程式異常導致金額暴衝。
    const MAX_BET_AMOUNT = 50000;
    // 【使用者 DevTools 實測驗證】目標平台的籌碼元素在被選取後，會被加上 "active" class
    // （例如 class="chip-100 active"）。點擊驗證機制利用此特徵確認「點擊是否真的生效」，
    // 而非單純假設 simulatePress() 有派發事件就等於選取成功。
    const CHIP_ACTIVE_CLASS_TOKEN = 'active';
    // 點擊籌碼後，等待多久再檢查該籌碼是否已出現 active 樣式（毫秒）。
    const CHIP_SELECTION_VERIFY_DELAY_MS = 90;
    // 驗證失敗時，最多重新嘗試點擊的次數（不含第一次），避免因平台未使用 active class
    // 或動畫延遲導致無限重試，超過重試上限仍失敗時，僅印出警告並照常繼續後續流程。
    const CHIP_SELECTION_MAX_RETRY = 2;
    // 搜尋「確定/確認」送出按鈕時比對的關鍵字清單（純文字型平台適用）。
    const CONFIRM_KEYWORDS = Object.freeze(['確定', '確認', '下注', '✓']);
    // 【使用者 DevTools 實測驗證】目標平台（手機端）採用 Vant UI 框架，確認鍵為標準圖示組件，
    // 精準 CSS 選擇器如下。此為最高優先策略，命中則直接使用，避免依賴較不穩定的
    // 顏色／文字啟發式判斷。若平台改版導致此選擇器失效，仍會自動退回既有備援策略。
    const CONFIRM_ICON_SELECTOR = 'i.van-icon-success, .van-icon-success';
    // 【新增：電腦端確認鍵，Ant Design 框架】依使用者 DevTools 截圖實測，電腦端確認鍵的
    // 真實 class 為 `ant-btn ant-btn-default btn btn-check`（另含一組會隨版本變動的
    // CSS-in-JS 雜湊 class，例如 `css-1hsjdkk`，此類雜湊值不穩定故不採用）。其中
    // `.btn-check` 為此按鈕唯一穩定且具語意的識別 class，故僅以此作為主要比對依據，
    // 並保留 `.ant-btn.btn-check` 作為次要備援（避免其他非按鈕元素誤用 btn-check 類名）。
    // 此為「純增量擴充」：僅新增電腦端選擇器加入既有 OR 清單，完全不影響、不變動
    // 手機端 Vant UI 既有的偵測邏輯與行為。
    const CONFIRM_DESKTOP_SELECTOR = 'button.btn-check, .ant-btn.btn-check, .btn-check';
    const BET_ELEMENT_CONFIG = Object.freeze({
        playerText: '閒',
        bankerText: '莊',
        tieText: '和',
        // 【賠率特徵鎖定】依使用者實測平台真實 DOM 截取的賠率文字，作為 .caption 文字比對
        // 之外的第二道精準比對條件，100% 排除龍寶、對子等其他共用 data-state 的雜牌賠率格。
        playerRatio: '1:1',
        bankerRatio: '1:0.95',
        // 【手機端 Vant UI + 電腦端 Ant Design 雙平台整合】以逗號合併的 CSS 選擇器清單，
        // querySelector 會依序嘗試整個 OR 清單，只要其中任何一個選擇器命中即視為找到目標，
        // 因此新增電腦端選擇器不會影響、也不會取代既有手機端邏輯，兩者可並存自動判斷。
        confirmSelector: `${CONFIRM_ICON_SELECTOR}, ${CONFIRM_DESKTOP_SELECTOR}`,
        confirmDelayMs: 400
    });

    // 【座標備援機制配置】當 DOM 選擇器與精確文字比對「都找不到」目標元素時（例如手機端
    // Shadow DOM、Canvas 渲染或 class 混淆導致偵測失敗），才會退回以「視窗寬高比例座標」
    // 直接點擊畫面對應位置作為最後手段。這些比例值是依使用者實際手機截圖校準，
    // 僅適用於相同螢幕比例／版面配置；若換裝置或版面改版導致座標失準，
    // 請重新截圖量測後修改本設定物件即可，不需更動下方點擊邏輯。
    // 【重要】此為「最後備援」，永遠優先嘗試 DOM/文字比對，只有兩者都失敗才會啟用座標點擊，
    // 避免座標失準時誤觸畫面上其他真實金錢相關的按鈕。
    const MOBILE_COORDINATE_CONFIG = Object.freeze({
        // 各籌碼面額對應的視窗寬高比例座標（x, y 皆為 0~1 之間的比例）。
        chips: Object.freeze({
            100: Object.freeze({ x: 0.12, y: 0.70 }),
            500: Object.freeze({ x: 0.24, y: 0.70 }),
            1000: Object.freeze({ x: 0.36, y: 0.70 }),
            5000: Object.freeze({ x: 0.48, y: 0.70 }),
            10000: Object.freeze({ x: 0.60, y: 0.70 }),
            50000: Object.freeze({ x: 0.72, y: 0.70 })
        }),
        // 莊/閒投注格中心點的比例座標。
        betArea: Object.freeze({
            莊: Object.freeze({ x: 0.83, y: 0.63 }),
            閒: Object.freeze({ x: 0.17, y: 0.63 })
        }),
        // 點擊投注格後彈出的「綠色打勾」確認鈕比例座標（依莊/閒各自彈出位置不同）。
        confirm: Object.freeze({
            莊: Object.freeze({ x: 0.78, y: 0.54 }),
            閒: Object.freeze({ x: 0.26, y: 0.54 })
        })
    });

    // 【純圖標送出鍵特徵】許多平台的送出鍵僅為圖標（例如白色打勾），沒有任何文字，
    // 因此改用 class 名稱特徵定位：命中以下關鍵字視為「確認/送出」按鈕。
    const CONFIRM_CLASS_KEYWORDS = Object.freeze(['confirm', 'submit', 'ok', 'success']);

    // 【尺寸天花板：已放寬】防止程式誤把大於畫面的背景 DIV（例如 402x624 的整版容器）
    // 當作可點擊的籌碼或投注格按鈕。原先設定過於嚴苛（65px／220px），在高解析度手機、
    // 不同 UI 縮放比例或不同瀏覽器下，正常按鈕的渲染像素很容易超標，導致程式誤判為
    // 「背景大容器」而整批略過，造成完全無法下注。現改為「絕對尺寸放寬 + 相對視窗比例」
    // 雙重防線（見 isWithinSizeCap），僅在絕對尺寸與相對視窗占比同時超標時才視為誤判。
    // 籌碼按鈕的合理尺寸上限（px）：放寬至可容納約 2 倍縮放後的正常按鈕尺寸。
    const CHIP_ELEMENT_MAX_SIZE_PX = 100;
    // 投注格（莊/閒）的合理尺寸上限（px）：放寬後仍遠小於整版背景容器。
    const BET_AREA_ELEMENT_MAX_SIZE_PX = 300;
    // 【相對視窗比例防線】無論裝置解析度或縮放比例為何，正常按鈕都不可能同時佔滿
    // 視窗寬與高各 55% 以上；只有真正的整版背景容器才會符合此條件，藉此避免絕對
    // 尺寸天花板在不同裝置上誤殺合法按鈕。
    const OVERSIZED_VIEWPORT_RATIO = 0.55;

    /**
     * 【尺寸天花板檢查：雙重防線版】判斷元素是否為「合法可點擊目標」而非誤判成的
     * 大範圍背景容器。採兩層判斷，任一層通過即視為合法：
     *   1. 絕對尺寸：寬與高「同時」不超過 maxSizePx（已放寬，容納高解析度/縮放情境）。
     *   2. 相對視窗比例：即使絕對尺寸略超標，只要寬與高並未「同時」達到視窗尺寸的
     *      OVERSIZED_VIEWPORT_RATIO（55%）以上，仍視為合法（真正的整版背景容器
     *      通常會同時佔滿畫面寬與高的大半，而正常按鈕不會）。
     * 元素必須先具備實際佔用畫面空間（寬高皆 > 0）才會進入後續判斷。
     * @param {Element} element
     * @param {number} maxSizePx 允許的最大寬／高（px），做為第一層判斷基準
     * @returns {boolean}
     */
    function isWithinSizeCap(element, maxSizePx) {
        try {
            if (!element || typeof element.getBoundingClientRect !== 'function') return false;
            const rect = element.getBoundingClientRect();
            if (!(rect.width > 0 && rect.height > 0)) return false;
            if (rect.width <= maxSizePx && rect.height <= maxSizePx) return true;
            // 第一層絕對尺寸超標，改用相對視窗比例防線再判斷一次。
            const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
            const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
            if (viewportWidth > 0 && viewportHeight > 0) {
                const widthRatio = rect.width / viewportWidth;
                const heightRatio = rect.height / viewportHeight;
                if (widthRatio < OVERSIZED_VIEWPORT_RATIO && heightRatio < OVERSIZED_VIEWPORT_RATIO) return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    /**
     * 【跨框架蒐集器】遞迴收集目前頁面本身與所有「同源、可存取」的 iframe contentDocument。
     * 跨網域 iframe 存取時會拋出例外，安全略過該層即可，不影響其餘框架的搜尋。支援巢狀 iframe。
     * @returns {Document[]} 所有可搜尋的 document 清單（至少包含目前頁面本身）
     */
    function collectSearchRoots() {
        const roots = [document];
        try {
            const queue = [document];
            while (queue.length > 0) {
                const currentDoc = queue.shift();
                let frames = [];
                try {
                    frames = Array.from(currentDoc.querySelectorAll('iframe'));
                } catch (error) {
                    continue; // 此層文件無法查詢 iframe（極罕見情況），安全略過
                }
                frames.forEach(frame => {
                    try {
                        const innerDoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
                        if (innerDoc && roots.indexOf(innerDoc) === -1) {
                            roots.push(innerDoc);
                            queue.push(innerDoc); // 繼續往巢狀 iframe 內部搜尋
                        }
                    } catch (error) {
                        // 跨網域 iframe 受瀏覽器安全限制無法存取，安全略過
                    }
                });
            }
        } catch (error) {
            console.warn('[自動下注] 跨框架搜尋時發生例外，已安全略過：', error);
        }
        return roots;
    }

    /**
     * 內部共用：對指定元素、在指定座標，派發完整的 pointerdown → mousedown → pointerup →
     * mouseup → click 事件鏈。供 simulatePress()（依元素中心點）與 dispatchRatioPress()
     * （依視窗比例座標）共用，避免重複實作。最後優先使用原生 click activation，
     * 讓 Vue/Vant 元件能執行需要瀏覽器 activation behavior 的狀態切換。
     * @param {Element} element
     * @param {number} clientX
     * @param {number} clientY
     * @returns {boolean}
     */
    function dispatchFullPressEvents(element, clientX, clientY) {
        if (!element || typeof element.dispatchEvent !== 'function') return false;
        try {
            const baseInit = { bubbles: true, cancelable: true, view: window, clientX, clientY };
            const dispatchSafe = (type, isPointerEvent) => {
                try {
                    const EventCtor = (isPointerEvent && typeof PointerEvent !== 'undefined') ? PointerEvent : MouseEvent;
                    const init = isPointerEvent ? { ...baseInit, pointerType: 'touch', isPrimary: true } : baseInit;
                    element.dispatchEvent(new EventCtor(type, init));
                } catch (error) {
                    // 部分瀏覽器可能不支援特定事件建構子，安全略過該事件，不影響其餘事件觸發。
                }
            };
            dispatchSafe('pointerdown', true);
            dispatchSafe('mousedown', false);
            dispatchSafe('pointerup', true);
            dispatchSafe('mouseup', false);
            try {
                if (typeof element.click === 'function') {
                    element.click();
                } else {
                    dispatchSafe('click', false);
                }
            } catch (error) {
                dispatchSafe('click', false);
            }
            return true;
        } catch (error) {
            console.warn('[自動下注] 事件派發時發生例外，已安全略過：', error);
            return false;
        }
    }

    /**
     * 【真人模擬按壓】依序觸發 pointerdown → mousedown → pointerup → mouseup → click，
     * 完整模擬手指在觸控螢幕「壓下並放開」的物理動作。任一事件類型建構失敗都不影響
     * 其餘事件觸發，最大化在各種手機瀏覽器上的相容性。
     * @param {Element} element 要按壓的目標元素
     * @returns {boolean} 是否成功執行按壓流程
     */
    function simulatePress(element) {
        if (!element || typeof element.dispatchEvent !== 'function') return false;
        try {
            const rect = typeof element.getBoundingClientRect === 'function'
                ? element.getBoundingClientRect()
                : { left: 0, top: 0, width: 0, height: 0 };
            const clientX = rect.left + (rect.width / 2);
            const clientY = rect.top + (rect.height / 2);
            return dispatchFullPressEvents(element, clientX, clientY);
        } catch (error) {
            console.warn('[自動下注] simulatePress 執行時發生例外，已安全略過：', error);
            return false;
        }
    }

    /**
     * 【座標備援：僅在 DOM 選擇器與精確文字比對皆失敗時使用】依視窗寬高比例（0~1）
     * 計算實際像素座標，找出該座標下方的元素（document.elementFromPoint），並對其派發
     * 與 simulatePress 相同的完整事件鏈。座標需依實際裝置螢幕比例校準（見
     * MOBILE_COORDINATE_CONFIG），若換裝置或版面改版導致座標失準，僅需調整該設定物件。
     * @param {number} ratioX 0~1 之間的水平比例（相對於 window.innerWidth）
     * @param {number} ratioY 0~1 之間的垂直比例（相對於 window.innerHeight）
     * @returns {boolean} 是否成功找到元素並派發事件
     */
    function dispatchRatioPress(ratioX, ratioY) {
        try {
            const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
            const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
            if (!viewportWidth || !viewportHeight) return false;
            const pixelX = viewportWidth * ratioX;
            const pixelY = viewportHeight * ratioY;
            const targetElement = (typeof document.elementFromPoint === 'function' && document.elementFromPoint(pixelX, pixelY)) || null;
            if (!targetElement) {
                console.warn(`[自動下注][座標備援] 座標比例 (${ratioX}, ${ratioY}) 對應像素 (${pixelX.toFixed(1)}, ${pixelY.toFixed(1)}) 找不到任何元素，已略過。`);
                return false;
            }
            const success = dispatchFullPressEvents(targetElement, pixelX, pixelY);
            if (success) {
                console.log(`[自動下注][座標備援] 已於比例座標 (${ratioX}, ${ratioY}) → 像素 (${pixelX.toFixed(1)}, ${pixelY.toFixed(1)}) 觸發點擊`);
            }
            return success;
        } catch (error) {
            console.warn('[自動下注][座標備援] 座標點擊時發生例外，已安全略過：', error);
            return false;
        }
    }

    function isInsideEnginePanel(element) {
        try {
            let current = element;
            while (current && current.nodeType === 1) {
                if (current.id === 'baccarat-ultimate-engine') return true;
                current = current.parentElement;
            }
        } catch (error) {
            return false;
        }
        return false;
    }

    /**
     * 【文字正規化】移除所有空白字元（含半形/全形空格、Tab、換行）並將全形冒號「：」
     * 統一轉換為半形冒號「:」，用於賠率文字比對前的前置處理。平台在不同版本或框架
     * 渲染下，`.ratio` 文字可能夾帶多餘空白或換行（例如 "1 : 1"、"1:1\n"），若不正規化
     * 直接做完全相等比對，會導致原本正確的賠率文字比對失敗、進而找不到任何投注格。
     * @param {*} text
     * @returns {string}
     */
    function normalizeRatioText(text) {
        return String(text || '')
            .replace(/：/g, ':')
            .replace(/\s+/g, '');
    }

    /**
     * 【賠率特徵比對】檢查投注格容器內的 `.ratio` 文字是否與預期賠率相符（比對前
     * 皆先經過 normalizeRatioText 正規化，移除空白差異與全形冒號差異的干擾）。
     * 這是繼 `.caption` 文字比對之後的第二道精準防線：龍寶、對子等雜牌格雖然可能與
     * 正莊/正閒共用相同的 data-state，但賠率文字（例如 1:1、1:0.95）必然不同，
     * 兩者同時比對即可鎖定唯一目標，同時避免因空白/換行等排版差異誤判失敗。
     * @param {Element} container 投注格容器（例如 li[data-state] 節點）
     * @param {string|null} expectedRatioText 預期賠率文字；傳入 null/undefined 時視為不檢查（直接通過）
     * @returns {boolean}
     */
    function elementMatchesRatioText(container, expectedRatioText) {
        if (!expectedRatioText) return true; // 未提供賠率規格（例如「和」）時，不強制要求，維持向後相容
        try {
            if (!container || typeof container.querySelector !== 'function') return false;
            const ratioElement = container.querySelector('.ratio');
            const ratioText = normalizeRatioText((ratioElement?.innerText ?? ratioElement?.textContent) || '');
            return ratioText === normalizeRatioText(expectedRatioText);
        } catch (error) {
            return false;
        }
    }

    /**
     * 【Vant UI 隱藏狀態偵測】判斷元素是否因 `style="display: none;"`（含 inline 或 computed）
     * 而被視為不可互動。平台會將尚未觸發的 `.betBtn` 確認彈窗（叉/分享/打勾三鍵）隱藏起來，
     * 只有在使用者實際點擊該格放置籌碼後，才會動態解除隱藏；此函式僅作為「單次檢查」
     * 輔助工具，不用於任何「本局是否開放下注」的全域判斷（該假設經實測證實不成立）。
     * @param {Element} element
     * @returns {boolean}
     */
    function isElementHiddenByDisplayNone(element) {
        try {
            if (!element) return false;
            if (element.style && element.style.display === 'none') return true;
            const ownerWindow = (element.ownerDocument && element.ownerDocument.defaultView) || (typeof window !== 'undefined' ? window : null);
            if (ownerWindow && typeof ownerWindow.getComputedStyle === 'function') {
                return ownerWindow.getComputedStyle(element).display === 'none';
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    /**
     * 【Vant UI 停用狀態偵測】判斷元素本身是否帶有 `disabled` 屬性/特性，
     * 或具備 `van-button--disabled` 這類語意化 class，代表目前無法點擊。
     * @param {Element} element
     * @returns {boolean}
     */
    function isVanButtonDisabled(element) {
        try {
            if (!element) return false;
            if (element.disabled === true) return true;
            if (typeof element.getAttribute === 'function' && element.getAttribute('disabled') !== null) return true;
            if (element.classList && element.classList.contains('van-button--disabled')) return true;
            return false;
        } catch (error) {
            return false;
        }
    }

    function isVisibleBetElement(element) {
        try {
            if (!element || isInsideEnginePanel(element) || typeof element.getBoundingClientRect !== 'function') return false;
            const rect = element.getBoundingClientRect();
            const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
            const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
            return rect.width > 0 && rect.height > 0 &&
                rect.bottom >= 0 && rect.right >= 0 &&
                rect.top <= viewportHeight && rect.left <= viewportWidth;
        } catch (error) {
            return false;
        }
    }

    function getInteractiveClickTarget(element) {
        try {
            if (!isVisibleBetElement(element)) return null;
            const interactiveSelector = 'button, [role="button"], [onclick], a, [class*="bet"], [class*="zone"], [class*="area"]';
            let current = element;
            for (let depth = 0; current && depth <= 5; depth += 1) {
                if (isInsideEnginePanel(current)) return null;
                if (current.matches && current.matches('button, [role="button"]') &&
                    (current.disabled || current.getAttribute('aria-disabled') === 'true' ||
                        current.classList?.contains('van-button--disabled'))) return null;
                if (current.matches && current.matches(interactiveSelector) && isVisibleBetElement(current)) return current;
                current = current.parentElement;
            }

            return element;
        } catch (error) {
            return null;
        }
    }

    function getEnabledConfirmButton(element) {
        try {
            let current = element;
            for (let depth = 0; current && depth <= 4; depth += 1) {
                if (current.matches && current.matches('button, [role="button"]')) {
                    if (current.disabled || current.getAttribute('aria-disabled') === 'true' ||
                        current.classList?.contains('van-button--disabled')) return null;
                    return isVisibleBetElement(current) ? current : null;
                }
                current = current.parentElement;
            }
        } catch (error) {
            return null;
        }
        return null;
    }

    /**
     * 【精準文字比對】在指定範圍（document 或某個容器元素）內，尋找 innerText/textContent
     * 符合條件、且文字最短（最貼近葉節點）的元素，避免點擊到涵蓋過大範圍的父容器，
     * 導致誤觸周圍的龍寶、對子等按鈕。
     * @param {Document|Element} root 搜尋範圍
     * @param {{include?: string[], exclude?: string[], tags?: string[]}} options
     * @returns {Element|null}
     */
    function findPreciseTextElement(root, options) {
        const include = (options && options.include) || [];
        const exclude = (options && options.exclude) || [];
        const tags = (options && options.tags) || ['div', 'li', 'span', 'button', 'a'];
        try {
            if (!root || typeof root.querySelectorAll !== 'function' || include.length === 0) return null;
            const candidates = Array.from(root.querySelectorAll(tags.join(',')));
            const matches = candidates.filter(element => {
                const text = ((element.innerText !== undefined ? element.innerText : element.textContent) || '').trim();
                if (!text || text.length > 30) return false; // 排除空文字與過長文字的大容器，避免誤判整個版面
                const hasInclude = include.some(keyword => text.includes(keyword));
                const hasExclude = exclude.some(keyword => text.includes(keyword));
                return hasInclude && !hasExclude;
            });
            if (matches.length === 0) return null;
            matches.sort((a, b) => {
                const lengthA = ((a.innerText !== undefined ? a.innerText : a.textContent) || '').trim().length;
                const lengthB = ((b.innerText !== undefined ? b.innerText : b.textContent) || '').trim().length;
                return lengthA - lengthB; // 文字越短越貼近葉節點，優先採用，降低誤觸大範圍容器的風險
            });
            return matches[0];
        } catch (error) {
            return null;
        }
    }

    /**
     * 【DevTools 實測驗證：精確可見文字比對】依使用者透過瀏覽器開發者工具實測抓取的規格，
     * 在 `div`/`span` 標籤中尋找文字（trim 後）與 keyword **完全相等**（而非包含）、
     * 且元素目前「可見」（`getBoundingClientRect().top > 0`）的元素。
     * 相較於 findPreciseTextElement 的「包含比對」，完全相等能天然排除「莊對」「閒龍寶」
     * 等含有相同關鍵字但文字不同的干擾元素，且可見性檢查能過濾掉隱藏或畫面外的重複節點。
     * 此為 findBetAreaElement 的最高優先策略（Tier 0）。
     * @param {Document|Element} root 搜尋範圍
     * @param {string} keyword 必須完全相等的文字（例如 '莊'、'閒'、'和'）
     * @returns {Element|null}
     */
    function findExactVisibleTextElement(root, keyword) {
        try {
            if (!root || typeof root.querySelectorAll !== 'function' || !keyword) return null;
            const candidates = Array.from(root.querySelectorAll('div, span'));
            return candidates.find(element => {
                try {
                    const text = ((element.innerText !== undefined ? element.innerText : element.textContent) || '').trim();
                    if (text !== keyword) return false;
                    return isVisibleBetElement(element);
                } catch (innerError) {
                    return false;
                }
            }) || null;
        } catch (error) {
            return null;
        }
    }

    /**
     * 尋找「正莊」、「正閒」（或「和」，為未來擴充預留）的精準投注文字元素。
     * 採兩層優先策略（皆強制套用尺寸天花板，徹底阻斷誤認成整版背景大容器）：
     *   Tier 0（最高優先，DevTools 實測驗證）：直接複用 findMainBetContainer 的
     *          「data-state + .caption 文字 + .ratio 賠率」三重比對結果鎖定唯一容器，
     *          確保與下注視窗開放狀態偵測、確認鍵範圍鎖定使用「同一個」容器節點。
     *          在此容器內，依序嘗試以下三種點擊目標（由精準到寬鬆）：
     *            1. `.chip-group`：真實平台會把「已下注的籌碼圖示」放進此節點，
     *               這才是實際綁定下注事件的互動熱區（對應 BET_SELECTORS.banker/
     *               player 原始設計的選擇器）。優先點擊此節點可避免「點擊 li 本身
     *               卻沒有事件監聽、導致下注完全沒有註冊」的情況（表現為：籌碼
     *               選取驗證成功、投注格「已點擊」，但 betBtn/value 永遠不會解鎖）。
     *            2. 若 `.chip-group` 不存在/不可見/超標，退回整個 li 容器本身
     *               （若未超過尺寸天花板）。
     *            3. 兩者皆不可用時，退回內層 `.caption` 文字節點。
     *          三者皆超標或找不到才視為誤判，繼續嘗試 Tier 1。
     *   Tier 1：全頁面（含所有 iframe）掃描 `div`、`span`，只允許命中文字「完全等於」
     *          '莊' 或 '閒' 且可見、且尺寸未超過天花板的元素，天然排除「莊對」
     *          「閒龍寶」等含相同字但文字不同的干擾元素。
     * 兩層皆找不到合法目標時回傳 null，由呼叫端負責退回座標備援機制。
     * @param {'莊'|'閒'|'和'} direction
     * @returns {Element|null}
     */
    function findBetAreaElement(direction) {
        const includeKeyword = direction === '莊'
            ? BET_ELEMENT_CONFIG.bankerText
            : direction === '閒'
                ? BET_ELEMENT_CONFIG.playerText
                : direction === '和'
                    ? BET_ELEMENT_CONFIG.tieText
                    : null;
        if (!includeKeyword) return null;

        // Tier 0：與 findMainBetContainer 共用同一套「data-state + caption + ratio」
        // 精準比對邏輯，確保後續籌碼點擊、下注視窗解鎖偵測、確認鍵搜尋鎖定同一容器。
        try {
            const mainBet = findMainBetContainer(direction);
            if (mainBet) {
                // 【優先點擊真正的下注熱區 .chip-group】對齊 BET_SELECTORS.banker/player
                // 原始設計與使用者實測 DOM 結構（籌碼圖示實際落點）。
                const chipGroup = mainBet.querySelector('.chip-group');
                if (chipGroup && isVisibleBetElement(chipGroup) && isWithinSizeCap(chipGroup, BET_AREA_ELEMENT_MAX_SIZE_PX)) {
                    return chipGroup;
                }
                // 【尺寸天花板】投注格容器本身若未超標，退而採用；否則改用 .caption 文字節點，
                // 三者皆超過天花板時視為誤判背景大容器，繼續嘗試 Tier 1（不強行採用）。
                if (isWithinSizeCap(mainBet, BET_AREA_ELEMENT_MAX_SIZE_PX)) return mainBet;
                const caption = mainBet.querySelector('.caption');
                if (caption && isVisibleBetElement(caption) && isWithinSizeCap(caption, BET_AREA_ELEMENT_MAX_SIZE_PX)) return caption;
            }
        } catch (error) {
            // 忽略，繼續嘗試 Tier 1 全頁面文字比對 fallback。
        }

        const roots = collectSearchRoots();

        // Tier 1：全頁面精確文字比對（完全相等，非包含比對），並套用相同尺寸天花板。
        for (const root of roots) {
            try {
                const candidates = Array.from(root.querySelectorAll('div, span'));
                const matched = candidates.find(element => {
                    if (isInsideEnginePanel(element) || !isVisibleBetElement(element)) return false;
                    if (!isWithinSizeCap(element, BET_AREA_ELEMENT_MAX_SIZE_PX)) return false;
                    const text = ((element.innerText !== undefined ? element.innerText : element.textContent) || '').trim();
                    return text === includeKeyword;
                });
                if (matched) return matched;
            } catch (error) {
                continue; // 單一 root 搜尋失敗不影響其他 root，繼續嘗試下一個
            }
        }
        return null;
    }

    /**
     * 尋找「正莊」「正閒」（或「和」）在 `li[data-state]` 底下的精準投注容器。
     * 採「.caption 文字 + .ratio 賠率文字」雙重比對：龍寶、對子等雜牌格雖可能共用
     * 相同的 data-state，但賠率必然不同（例如莊 1:0.95、閒 1:1），兩者同時命中
     * 才視為合法目標，100% 排除誤觸風險。此函式同時是 findBetAreaElement、
     * 下注視窗開放狀態偵測、確認鍵範圍鎖定三處邏輯共用的「唯一容器來源」，
     * 確保全流程鎖定的是同一個投注格節點，不會出現各函式各自判斷造成落差。
     * @param {'莊'|'閒'|'和'} direction
     * @returns {Element|null}
     */
    function findMainBetContainer(direction) {
        const state = direction === '莊' ? 'zhuang' : direction === '閒' ? 'free' : 'mix';
        const expectedCaption = direction === '莊' ? '莊' : direction === '閒' ? '閒' : '和';
        const expectedRatio = direction === '莊' ? BET_ELEMENT_CONFIG.bankerRatio
            : direction === '閒' ? BET_ELEMENT_CONFIG.playerRatio
                : null; // 「和」目前無賠率規格，維持僅比對文字
        for (const root of collectSearchRoots()) {
            try {
                const candidates = Array.from(root.querySelectorAll(`li[data-state="${state}"]`));
                const match = candidates.find(element => {
                    const caption = element.querySelector('.caption');
                    const text = ((caption?.innerText ?? caption?.textContent) || '').trim();
                    return text === expectedCaption &&
                        elementMatchesRatioText(element, expectedRatio) &&
                        !isInsideEnginePanel(element) && isVisibleBetElement(element);
                });
                if (match) return match;
            } catch (error) {
                continue;
            }
        }
        return null;
    }

    /**
     * 依面額回傳畫面上可能顯示的所有文字變體。大於等於 1000 且為 1000 整數倍的面額，
     * 平台通常以「K 制」顯示（例如 1000→"1K"、5000→"5K"、10000→"10K"、50000→"50K"），
     * 因此除了純數字外，也一併提供 K 制大小寫變體，提高文字比對 fallback 的命中率。
     * @param {number} denomination
     * @returns {string[]}
     */
    function getChipLabelVariants(denomination) {
        const variants = [String(denomination)];
        if (denomination >= 1000 && denomination % 1000 === 0) {
            const kValue = denomination / 1000;
            variants.unshift(`${kValue}K`, `${kValue}k`);
        }
        return variants;
    }

    /**
     * 【精確文字比對】與 findPreciseTextElement 的子字串（includes）比對不同，本函式要求
     * 元素文字「完全等於」候選變體之一，避免例如搜尋面額「100」時，誤中文字為「1000」的
     * 籌碼元素（子字串包含關係造成的誤判）。多個完全相符的元素時，優先採用內部結構最簡單
     * （子孫元素數量最少、最貼近葉節點）的一個。
     * @param {Document|Element} root 搜尋範圍
     * @param {string[]} labelVariants 完全相符的候選文字清單
     * @param {string[]} [tags] 搜尋的標籤清單
     * @returns {Element|null}
     */
    function findExactTextElement(root, labelVariants, tags) {
        const searchTags = tags || ['div', 'li', 'span', 'button', 'a'];
        try {
            if (!root || typeof root.querySelectorAll !== 'function' || !labelVariants || labelVariants.length === 0) return null;
            const candidates = Array.from(root.querySelectorAll(searchTags.join(',')));
            const matches = candidates.filter(element => {
                const text = ((element.innerText !== undefined ? element.innerText : element.textContent) || '').trim();
                return text.length > 0 && labelVariants.includes(text);
            });
            if (matches.length === 0) return null;
            matches.sort((a, b) => {
                const descendantsA = typeof a.querySelectorAll === 'function' ? a.querySelectorAll('*').length : 0;
                const descendantsB = typeof b.querySelectorAll === 'function' ? b.querySelectorAll('*').length : 0;
                return descendantsA - descendantsB; // 子孫元素越少，越貼近葉節點，優先採用
            });
            return matches[0];
        } catch (error) {
            return null;
        }
    }

    /**
     * 判斷元素的 class 是否「完整詞元（token）」等於指定字串（大小寫不敏感）。
     * 與子字串（includes）比對不同，本函式將 className 依空白切割成獨立詞元後逐一比對，
     * 確保例如比對 "chip-1000" 時，不會誤判 class="chip-10000" 或 "chip-50000" 的元素
     * （這兩者雖然字串上「包含」了 "chip-1000" 這個子字串，但詞元本身完全不同）。
     * @param {Element} element
     * @param {string} token 欲精確比對的完整 class 詞元
     * @returns {boolean}
     */
    function elementHasExactClassToken(element, token) {
        try {
            if (!element || !token) return false;
            const rawClassName = typeof element.className === 'string'
                ? element.className
                : (element.getAttribute && element.getAttribute('class')) || '';
            const tokens = String(rawClassName).toLowerCase().split(/\s+/).filter(Boolean);
            return tokens.includes(String(token).toLowerCase());
        } catch (error) {
            return false;
        }
    }

    /**
     * 尋找指定面額的籌碼元素：先嘗試既有 CSS 選擇器，找不到時退回「精確文字比對」
     * （支援 K 制標籤，例如面額 1000 會嘗試比對「1K」），避免子字串誤判其他面額元素。
     * 【鋼鐵尺寸天花板】三層策略找到的候選元素，皆必須通過 CHIP_ELEMENT_MAX_SIZE_PX
     * （65px）尺寸檢查才會採用；任何超標的大容器（例如誤中 402x624 的背景 DIV）
     * 一律強制視為不合法目標，繼續嘗試下一層或下一個候選，絕不誤用。
     * @param {number} denomination
     * @returns {Element|null}
     */
    function findChipElement(denomination, direction) {
        const denominationClassToken = `chip-${denomination}`;
        // 【重要修正】容器內範圍搜尋時，必須嚴格比對「完整 class 詞元」等於指定面額
        // （例如 chip-1000），而非任何 class 開頭為 chip- 的元素就直接採用。修正前的舊邏輯
        // 會恆常回傳投注區域內找到的第一個籌碼元素（例如永遠命中 chip-500），導致無論
        // 設定金額為何，實際點擊的永遠是同一顆籌碼（例如「填 1000 卻一直點到 500」）。
        const mainBetContainer = findMainBetContainer(direction);
        if (mainBetContainer) {
            try {
                const scopedCandidates = Array.from(mainBetContainer.querySelectorAll('[class*="chip-"]'));
                const scopedChip = scopedCandidates.find(element =>
                    elementHasExactClassToken(element, denominationClassToken) &&
                    isVisibleBetElement(element) &&
                    isWithinSizeCap(element, CHIP_ELEMENT_MAX_SIZE_PX)
                );
                if (scopedChip) return scopedChip;
            } catch (error) {
                // 繼續使用既有面額 selector fallback。
            }
        }
        const selector = BET_SELECTORS.chips[denomination];
        const roots = collectSearchRoots();
        for (const root of roots) {
            try {
                if (selector) {
                    const element = root.querySelector(selector);
                    if (element && isVisibleBetElement(element) && isWithinSizeCap(element, CHIP_ELEMENT_MAX_SIZE_PX)) return element;
                }
            } catch (error) {
                continue;
            }
        }
        const labelVariants = getChipLabelVariants(denomination);
        for (const root of roots) {
            try {
                const element = findExactTextElement(root, labelVariants);
                if (element && isWithinSizeCap(element, CHIP_ELEMENT_MAX_SIZE_PX)) return element;
            } catch (error) {
                continue;
            }
        }
        return null;
    }

    /**
     * 判斷指定籌碼元素目前是否已被平台標記為「選取中」（class 含 active 詞元）。
     * 用於「點擊驗證機制」：確認 simulatePress() 派發的事件是否真的讓平台切換了
     * 目前選取面額，而不是單純假設事件有派發就等於選取成功。
     * @param {Element} chipElement
     * @returns {boolean}
     */
    function isChipElementActive(chipElement) {
        return elementHasExactClassToken(chipElement, CHIP_ACTIVE_CLASS_TOKEN);
    }

    /**
     * 【點擊驗證機制】點擊指定籌碼元素後，延遲 CHIP_SELECTION_VERIFY_DELAY_MS 檢查該元素
     * 是否已出現 active 樣式（代表平台已確實切換至此面額）。若尚未出現且仍有重試次數，
     * 會重新執行一次 simulatePress() 再次驗證；驗證成功或重試次數用盡才會呼叫 onVerified()。
     * 即使最終仍驗證失敗（例如平台未使用 active class 標記選取狀態），也只印出警告並繼續
     * 後續流程，絕不因驗證失敗而中斷整體下注流程。
     * @param {Element} chipElement 要點擊並驗證的籌碼元素
     * @param {number} denomination 面額（僅用於 log 訊息）
     * @param {number} attempt 目前第幾次嘗試（從 0 開始）
     * @param {(success: boolean) => void} onVerified 驗證流程結束後的回呼，success 代表是否確認選取成功
     */
    function selectChipWithVerification(chipElement, denomination, attempt, onVerified) {
        try {
            simulatePress(chipElement);
        } catch (error) {
            console.warn(`[自動下注][點擊驗證] 點擊 ${denomination} 元籌碼時發生例外，已安全略過：`, error);
        }
        setTimeout(() => {
            let active = false;
            try {
                active = isChipElementActive(chipElement);
            } catch (error) {
                active = false;
            }
            if (active) {
                console.log(`[自動下注][點擊驗證] 已確認 ${denomination} 元籌碼成功切換為選取狀態（active）。`);
                onVerified(true);
                return;
            }
            if (attempt < CHIP_SELECTION_MAX_RETRY) {
                console.warn(`[自動下注][點擊驗證] ${denomination} 元籌碼尚未偵測到 active 樣式，正在重試第 ${attempt + 2} 次點擊...`);
                selectChipWithVerification(chipElement, denomination, attempt + 1, onVerified);
                return;
            }
            console.warn(`[自動下注][點擊驗證] ${denomination} 元籌碼重試 ${CHIP_SELECTION_MAX_RETRY} 次後仍未偵測到 active 樣式，可能平台未使用此標記或點擊未生效，將照常繼續後續流程。`);
            onVerified(false);
        }, CHIP_SELECTION_VERIFY_DELAY_MS);
    }

    /**
     * 判斷元素的 class 名稱是否命中指定關鍵字清單（大小寫不敏感）。
     * @param {Element} element
     * @param {string[]} keywords
     * @returns {boolean}
     */
    function classNameIncludesAny(element, keywords) {
        try {
            if (!element) return false;
            const rawClassName = typeof element.className === 'string'
                ? element.className
                : (element.getAttribute && element.getAttribute('class')) || '';
            const normalized = String(rawClassName).toLowerCase();
            return keywords.some(keyword => normalized.includes(keyword));
        } catch (error) {
            return false;
        }
    }

    /**
     * 【投注格範圍鎖定：策略零加強版】直接在「剛才點擊的同一個 li 投注格容器」內
     * 尋找確認鍵：手機端為 `.van-button--success`（內含 `van-icon-success`），
     * 電腦端為 `.btn-check`（Ant Design 按鈕，見 CONFIRM_DESKTOP_SELECTOR）。
     * 相較於全頁面搜尋，範圍鎖定在同一容器內可 100% 避免誤觸其他區域的相似按鈕，
     * 且天然對齊使用者截取的真實 DOM 結構（`.betBtn` 內第三個按鈕，或電腦端投注格
     * 內的確認按鈕）。新增電腦端選擇器為純增量擴充，找不到時不影響手機端既有邏輯。
     * @param {'莊'|'閒'} direction
     * @returns {Element|null} 找到的按鈕元素（無論目前是否 disabled），找不到容器/按鈕則回傳 null
     */
    function findScopedConfirmButton(direction) {
        try {
            const container = findMainBetContainer(direction);
            if (!container || typeof container.querySelector !== 'function') return null;
            return container.querySelector(`.betBtn .van-button--success, .van-button--success, ${CONFIRM_DESKTOP_SELECTOR}`) || null;
        } catch (error) {
            return null;
        }
    }

    /**
     * 判斷投注格範圍內找到的確認按鈕「現在」是否真正可點擊：
     * 需同時滿足未被 `disabled`、按鈕本身未被 `display:none` 隱藏、
     * 且其最近的 `.betBtn` 父容器也未被整體隱藏。
     * @param {Element} button
     * @returns {boolean}
     */
    function isConfirmButtonReady(button) {
        try {
            if (!button || !isVisibleBetElement(button)) return false;
            if (isVanButtonDisabled(button)) return false;
            if (isElementHiddenByDisplayNone(button)) return false;
            const betBtnContainer = typeof button.closest === 'function' ? button.closest('.betBtn') : null;
            if (betBtnContainer && isElementHiddenByDisplayNone(betBtnContainer)) return false;
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * 【投注格內確認鍵：單次即時檢查】僅檢查「當下這一瞬間」投注格容器內的
     * `.van-button--success` 是否恰好已解鎖可點擊，若是則立即點擊送出並回傳 true；
     * 找不到元素、或元素仍處於 disabled／隱藏狀態，一律「不等待」直接回傳 false，
     * 交由呼叫端立即 fallback 至既有的全頁面三層策略／座標備援，避免任何多輪
     * setTimeout 輪詢造成的延遲（曾實測平台的 `.betBtn` 群組長時間維持鎖定狀態，
     * 並非「本局是否開放下注」的指標，持續輪詢只會拖慢下注速度、沒有實質幫助）。
     * @param {'莊'|'閒'} direction
     * @returns {boolean} true 代表已成功點擊送出
     */
    function tryClickScopedConfirmButton(direction) {
        try {
            const button = findScopedConfirmButton(direction);
            if (button && isConfirmButtonReady(button)) {
                simulatePress(button);
                console.log(`[自動下注][確認鍵定位] 策略零（投注格內 .van-button--success 精準鎖定）命中：${describeElementForDebug(button)}`);
                return true;
            }
        } catch (error) {
            console.warn('[自動下注][確認鍵定位] 掃描投注格內確認鍵時發生例外，已安全略過：', error);
        }
        return false;
    }

    /**
     * 尋找「確定/確認」送出按鈕，採三層漸進式定位策略（依序嘗試，任一層命中即回傳）：
     *   策略零（絕對最高優先，DevTools 實測驗證）：手機端 Vant UI 標準圖示選擇器
     *          `i.van-icon-success, .van-icon-success`，加上電腦端 Ant Design 確認鍵
     *          `.btn-check`（見 CONFIRM_DESKTOP_SELECTOR，依使用者截圖新增，純增量
     *          擴充，不影響手機端既有判斷），直接 querySelector 命中即用，兩平台皆為
     *          實測驗證過對應目標平台打勾送出鍵的策略。
     *   策略一：class 名稱直接命中 confirm/submit/ok/success（適用於有語意化 class 的平台）。
     *   策略二：文字比對「確定/確認/下注/✓」（相容純文字型舊平台）。
     * 【已移除】原策略二（取消鍵同層兄弟）與策略二點五（色彩／尺寸啟發式辨識），
     * 因兩者皆缺乏可靠語意依據，實測曾誤中畫面上的統計文字列等非按鈕元素。
     * 三層皆找不到時回傳 null，由呼叫端強制退回 MOBILE_COORDINATE_CONFIG.confirm
     * 的視窗比例座標進行物理點擊送出（最後備援手段）。
     * 【注意】本函式為全頁面搜尋 fallback；投注完成後應優先呼叫
     * `tryClickScopedConfirmButton(direction)` 做單次即時檢查（不等待、不輪詢），
     * 僅在該檢查失敗時才退回本函式繼續嘗試。
     * 全程支援跨 iframe（含巢狀）搜尋。
     * @returns {Element|null}
     */
    /**
     * 【除錯輔助】將元素轉換為簡短可讀描述（標籤、class、文字內容、畫面座標），
     * 用於在 Console 印出「本次點擊的究竟是哪個元素」，方便使用者在無法開啟
     * DevTools 的情況下，回報 log 供進一步診斷 DOM 定位是否命中正確目標。
     * @param {Element} element
     * @returns {string}
     */
    function describeElementForDebug(element) {
        try {
            if (!element) return '(null)';
            const rect = element.getBoundingClientRect();
            const tag = element.tagName ? element.tagName.toLowerCase() : '(?)';
            const className = (typeof element.className === 'string' ? element.className : '') || '(無class)';
            const text = ((element.innerText !== undefined ? element.innerText : element.textContent) || '').trim().slice(0, 20) || '(無文字)';
            return `<${tag} class="${className}"> 文字="${text}" 座標=(${rect.left.toFixed(0)}, ${rect.top.toFixed(0)}) 尺寸=${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`;
        } catch (error) {
            return '(描述失敗)';
        }
    }

    function findConfirmButtonElement() {
        const roots = collectSearchRoots();

        // 策略零：手機端 Vant UI 標準圖示選擇器 + 電腦端 Ant Design .btn-check 選擇器，
        // 兩者合併於 BET_ELEMENT_CONFIG.confirmSelector 內，DevTools 實測驗證，最高優先。
        for (const root of roots) {
            try {
                const matched = typeof root.querySelector === 'function' ? root.querySelector(BET_ELEMENT_CONFIG.confirmSelector) : null;
                const target = getEnabledConfirmButton(matched) || getInteractiveClickTarget(matched);
                if (target) {
                    console.log(`[自動下注][確認鍵定位] 策略零命中：${describeElementForDebug(target)}`);
                    return target;
                }
            } catch (error) {
                continue;
            }
        }

        // 策略一：class 名稱直接命中 confirm/submit/ok/success
        for (const root of roots) {
            try {
                const candidates = Array.from(root.querySelectorAll('button, div, span, i, a'));
                const matched = candidates.find(element =>
                    !isInsideEnginePanel(element) &&
                    isVisibleBetElement(element) &&
                    classNameIncludesAny(element, CONFIRM_CLASS_KEYWORDS)
                );
                const target = getEnabledConfirmButton(matched) || getInteractiveClickTarget(matched);
                if (target) {
                    console.log(`[自動下注][確認鍵定位] 策略一命中：${describeElementForDebug(target)}`);
                    return target;
                }
            } catch (error) {
                continue;
            }
        }

        // 策略二：文字比對「確定/確認/下注/✓」，相容純文字型舊平台
        for (const root of roots) {
            try {
                const element = findPreciseTextElement(root, { include: CONFIRM_KEYWORDS.slice(), exclude: [], tags: ['button', 'div'] });
                const target = getInteractiveClickTarget(element);
                if (target) {
                    console.log(`[自動下注][確認鍵定位] 策略二（文字比對）命中：${describeElementForDebug(target)}`);
                    return target;
                }
            } catch (error) {
                continue;
            }
        }
        console.warn('[自動下注][確認鍵定位] 三層策略皆未命中，將由呼叫端強制退回座標備援點擊。');
        return null;
    }

    /**
     * 【智慧面額拆解：物理貪婪分配算法】將下注金額由大到小拆解為目前平台既有籌碼面額組合。
     * 採 Math.floor 餘數法逐一貪婪扣除：先扣最大面額，餘數再扣次大面額，依序類推，
     * 完全對齊真人「先選大面額籌碼、再補小面額籌碼」的操作習慣。例如：
     *   - 200 元 → 100 元籌碼 x2（無 1000/500 面額可扣，退回最小面額 100）。
     *   - 600 元 → 500 元籌碼 x1、100 元籌碼 x1。
     *   - 1400 元 → 1000 元籌碼 x1、100 元籌碼 x4（500 面額扣一次會剩 400，
     *     不足以再扣 500，因此貪婪法會依序嘗試每個面額，500 扣 0 次、100 扣 4 次）。
     *   - 1500 元 → 1000 元籌碼 x1、500 元籌碼 x1。
     * 若金額非最小面額的整數倍，安全向下取整，避免金額溢位造成下注超額。
     * @param {number} amount
     * @returns {{denomination: number, count: number}[]}
     */
    function decomposeAmountToChips(amount) {
        const denominations = Object.keys(BET_SELECTORS.chips)
            .map(Number)
            .filter(value => Number.isFinite(value) && value > 0)
            .sort((a, b) => b - a); // 由大到小，貪婪法優先使用大面額，減少點擊次數
        if (denominations.length === 0 || !Number.isFinite(amount) || amount <= 0) return [];

        const smallestDenomination = denominations[denominations.length - 1];
        let remaining = Math.floor(amount / smallestDenomination) * smallestDenomination;
        const plan = [];
        denominations.forEach(denomination => {
            if (remaining <= 0) return;
            const count = Math.floor(remaining / denomination);
            if (count > 0) {
                plan.push({ denomination, count });
                remaining -= count * denomination;
            }
        });
        return plan;
    }

    /**
     * 對「投注格」（莊/閒）執行單次點擊，每點一次即疊加一次目前已選取面額的金額。
     * 找不到投注格元素時，退回座標備援機制；兩者皆失敗才印出警告（不拋出例外，
     * 不影響物理點擊佇列中其餘步驟的執行）。
     * @param {'莊'|'閒'} direction
     * @param {number} sequence 目前是第幾次疊加點擊（僅用於 log 顯示）
     * @param {number} total 本面額總共需要疊加的次數（僅用於 log 顯示）
     * @returns {boolean} 是否成功觸發點擊（含座標備援皆成功視為 true）
     */
    function pressBetAreaOnce(direction, sequence, total) {
        try {
            const betAreaElement = findBetAreaElement(direction);
            if (betAreaElement) {
                simulatePress(betAreaElement);
                console.log(`[自動下注] 已點擊「${direction}」投注格（第 ${sequence}/${total} 次疊加）`);
                return true;
            }
            // DOM 選擇器與精確文字比對皆找不到投注格時，退回座標備援機制（最後手段）。
            const coordinate = MOBILE_COORDINATE_CONFIG.betArea[direction];
            if (coordinate && dispatchRatioPress(coordinate.x, coordinate.y)) {
                console.log(`[自動下注][座標備援] 已改用座標點擊「${direction}」投注格（第 ${sequence}/${total} 次疊加）`);
                return true;
            }
            console.warn(`[自動下注] 找不到「${direction}」投注格元素（含座標備援皆失敗），已跳過本次疊加點擊（第 ${sequence}/${total} 次）。`);
            return false;
        } catch (error) {
            console.warn('[自動下注] 點擊投注格時發生例外，已安全略過：', error);
            return false;
        }
    }

    /**
     * 點擊指定面額的籌碼一次，並以 selectChipWithVerification 主動驗證 active 樣式是否出現。
     * 找不到 DOM 元素時，退回座標備援機制（無法驗證 active，視為直接成功）。
     * @param {number} denomination
     * @param {'莊'|'閒'} direction
     * @param {number} sequence 面額序號（僅用於 log 顯示）
     * @param {number} total 本次下注共需選取的面額數量（僅用於 log 顯示）
     * @param {(selected: boolean) => void} onDone 選取流程結束後的回呼（無論成功與否都會呼叫）
     */
    function selectChipOnce(denomination, direction, sequence, total, onDone) {
        try {
            const chipElement = findChipElement(denomination, direction);
            if (chipElement) {
                console.log(`[自動下注] 準備選取 ${denomination} 元籌碼（面額 ${sequence}/${total}）`);
                selectChipWithVerification(chipElement, denomination, 0, () => onDone(true));
                return;
            }
            // DOM 選擇器與精確文字比對皆找不到籌碼時，退回座標備援機制（最後手段，
            // 座標點擊無法檢查 active 樣式，故視為直接成功，不套用點擊驗證機制）。
            const coordinate = MOBILE_COORDINATE_CONFIG.chips[denomination];
            if (coordinate && dispatchRatioPress(coordinate.x, coordinate.y)) {
                console.log(`[自動下注][座標備援] 已改用座標點擊選取 ${denomination} 元籌碼（面額 ${sequence}/${total}）`);
                onDone(true);
                return;
            }
            console.warn(`[自動下注] 找不到 ${denomination} 元籌碼元素（含座標備援皆失敗），已略過此面額（避免誤用其他已選取面額疊加金額）。`);
            onDone(false);
        } catch (error) {
            console.warn('[自動下注] 選取籌碼時發生例外，已安全略過此面額：', error);
            onDone(false);
        }
    }

    /**
     * 【物理貪婪分配算法：動作佇列建構器】將籌碼面額組合（已由 decomposeAmountToChips
     * 以 Math.floor 餘數法貪婪拆解）直接展開為一條線性的「物理點擊動作佇列」，
     * 每個元素代表一個獨立、可單獨執行的物理動作步驟，完全對齊真人操作順序：
     *   selectChip → clickBetArea（重複 count 次）→ 下一個面額的 selectChip → ... → confirm
     * 例如金額 1400 元（1000 元 x1、100 元 x4）會展開為：
     *   [selectChip:1000] → [clickBetArea:1] → [selectChip:100] → [clickBetArea:1]
     *   → [clickBetArea:2] → [clickBetArea:3] → [clickBetArea:4] → [confirm]
     * 佇列本身只是純資料結構，不含任何非同步邏輯，執行交由 runBetActionQueue 負責，
     * 讓「拆解計畫」與「實際執行」完全解耦，方便單獨測試與除錯。
     * @param {{denomination:number, count:number}[]} chipPlan
     * @returns {Array<{type:'selectChip', denomination:number, sequence:number, total:number}|{type:'clickBetArea', sequence:number, total:number}|{type:'confirm'}>}
     */
    function buildBetActionQueue(chipPlan) {
        const queue = [];
        const totalDenominations = chipPlan.length;
        chipPlan.forEach(({ denomination, count }, planIndex) => {
            queue.push({ type: 'selectChip', denomination, sequence: planIndex + 1, total: totalDenominations });
            for (let clickSeq = 1; clickSeq <= count; clickSeq += 1) {
                queue.push({ type: 'clickBetArea', sequence: clickSeq, total: count });
            }
        });
        queue.push({ type: 'confirm' });
        return queue;
    }

    /**
     * 【物理點擊佇列執行器】依序、逐一執行 buildBetActionQueue 產生的動作佇列。
     * 佇列內每一種動作類型的處理方式：
     *   - selectChip：呼叫 selectChipOnce 選取籌碼並等待 active 驗證完成，完成後才透過
     *     不超過 150ms 的 setTimeout（AUTO_BET_CLICK_DELAY_MS）排程下一步，讓平台有時間
     *     反應「目前選取面額」的狀態切換。
     *   - clickBetArea：呼叫 pressBetAreaOnce 對投注格連點一次，完成後透過不超過 150ms
     *     的 setTimeout（CHIP_CLICK_INTERVAL_MS）排程下一步。
     *   - confirm：所有面額皆已點擊完畢，延遲 CONFIRM_CLICK_DELAY_MS（此步驟需等待平台
     *     彈出確認鍵動畫渲染完成，經 DevTools 實測需要比其餘步驟更長的等待時間，
     *     故不受 150ms 佇列節奏限制）後，尋找並點擊「確定/確認」送出按鈕；找不到實體
     *     按鈕時，直接強制退回 MOBILE_COORDINATE_CONFIG.confirm[direction] 座標點擊送出。
     * 任一步驟發生例外都只印出警告並安全跳到下一步，絕不中斷整條佇列的執行。
     * @param {Array} queue buildBetActionQueue 產生的動作佇列
     * @param {number} index 目前執行到第幾個動作
     * @param {'莊'|'閒'} direction
     * @param {number} amount 僅用於 log 顯示的原始下注金額
     * @param {() => void} onFinished 佇列全部執行完畢後的回呼
     */
    function runBetActionQueue(queue, index, direction, amount, onFinished) {
        if (index >= queue.length) {
            onFinished();
            return;
        }
        const action = queue[index];

        if (action.type === 'selectChip') {
            selectChipOnce(action.denomination, direction, action.sequence, action.total, () => {
                setTimeout(() => runBetActionQueue(queue, index + 1, direction, amount, onFinished), AUTO_BET_CLICK_DELAY_MS);
            });
            return;
        }

        if (action.type === 'clickBetArea') {
            pressBetAreaOnce(direction, action.sequence, action.total);
            setTimeout(() => runBetActionQueue(queue, index + 1, direction, amount, onFinished), CHIP_CLICK_INTERVAL_MS);
            return;
        }

        // action.type === 'confirm'：物理點擊佇列的最後一步，等待確認鍵渲染後強制送出。
        // 先「單次即時檢查」剛才點擊的同一個投注格容器內是否已有可點擊的
        // .van-button--success（不等待、不輪詢，避免曾實測過的長時間卡頓），
        // 找不到才立即退回既有的全頁面三層策略，最終仍失敗才強制使用座標備援。
        setTimeout(() => {
            try {
                if (tryClickScopedConfirmButton(direction)) {
                    console.log(`[自動下注] 已完成完整下注流程：方向【${direction}】、金額 ${amount} 元（籌碼選取 + 投注格疊加 + 確認送出）`);
                    onFinished();
                    return;
                }
                const confirmElement = findConfirmButtonElement();
                if (confirmElement) {
                    simulatePress(confirmElement);
                    console.log(`[自動下注] 已完成完整下注流程：方向【${direction}】、金額 ${amount} 元（籌碼選取 + 投注格疊加 + 確認送出）`);
                } else {
                    // 【策略零/一/二皆未命中，直接強制退回座標備援】不再嘗試不穩定的色彩啟發式判斷。
                    const coordinate = MOBILE_COORDINATE_CONFIG.confirm[direction];
                    if (coordinate && dispatchRatioPress(coordinate.x, coordinate.y)) {
                        console.log(`[自動下注][座標備援] 已改用座標點擊完成完整下注流程：方向【${direction}】、金額 ${amount} 元`);
                    } else {
                        console.warn('[自動下注] 找不到「確定/確認」送出按鈕（含座標備援皆失敗），下注可能尚未送出，請人工確認。');
                    }
                }
            } catch (error) {
                console.warn('[自動下注] 點擊確認送出按鈕時發生例外，已安全略過：', error);
            }
            onFinished();
        }, CONFIRM_CLICK_DELAY_MS);
    }


    const AutoBetManager = {
        /**
         * 模擬下注：僅在瀏覽器 Console 印出偵測到的預測方向與投入金額，
         * 不進行任何真實 DOM 點擊或表單提交，安全供測試觀察使用。
         * @param {'莊'|'閒'} direction 預測方向
         * @param {number} amount 下注金額
         * @returns {{direction: string, amount: number, simulated: boolean, timestamp: string}}
         */
        simulateBet(direction, amount) {
            try {
                const safeDirection = (direction === '莊' || direction === '閒') ? direction : '未知';
                const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
                console.log(
                    `[自動下注測試] 偵測到新預測方向：【${safeDirection}】、預計投入金額：${safeAmount} 元、正在模擬點擊...（模擬成功）`
                );
                return { direction: safeDirection, amount: safeAmount, simulated: true, timestamp: new Date().toISOString() };
            } catch (error) {
                console.warn('[自動下注測試] 模擬下注發生例外，已安全略過：', error);
                return { direction: null, amount: 0, simulated: false, timestamp: new Date().toISOString() };
            }
        },

        /**
         * 【真實下注：物理貪婪分配算法版】完整流程（100% 對齊真人百家樂介面操作順序）：
         *   1. 依安全閥校正金額 → 以 decomposeAmountToChips 貪婪拆解為籌碼面額組合
         *      （由大到小：例如 1400 元 → 1000 元 x1、100 元 x4）。
         *   2. 透過 buildBetActionQueue 將拆解計畫直接展開為線性物理點擊動作佇列
         *      （selectChip → clickBetArea × N → 下一面額 → ... → confirm）。
         *   3. 交由 runBetActionQueue 依序執行整條佇列，每一步之間的排程一律使用
         *      不超過 150ms 的 setTimeout（confirm 步驟因需等待平台彈出動畫渲染完成，
         *      例外使用 CONFIRM_CLICK_DELAY_MS，經 DevTools 實測驗證為必要延遲）。
         * 全程使用 simulatePress()（pointerdown/mousedown/pointerup/mouseup/click 完整事件鏈）
         * 並支援跨 iframe（含巢狀）搜尋，任何步驟找不到元素都只印出警告、安全略過，絕不中斷。
         * @param {'莊'|'閒'} direction 預測方向
         * @param {number} amount 下注金額
         */
        placeRealBet(direction, amount) {
            try {
                if (direction !== '莊' && direction !== '閒') {
                    console.warn('[自動下注] placeRealBet 收到未知的預測方向，已略過：', direction);
                    return;
                }

                // 【安全閥】5 萬元下注上限：任何超過 MAX_BET_AMOUNT 的金額，
                // 在正式點擊前一律自動重設為上限值，並印出安全警告，絕不放行超額下注。
                let safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
                if (safeAmount > MAX_BET_AMOUNT) {
                    console.warn(`[自動下注][安全警告] 偵測到下注金額 ${safeAmount} 元超過安全上限 ${MAX_BET_AMOUNT} 元，已自動重設為 ${MAX_BET_AMOUNT} 元。`);
                    safeAmount = MAX_BET_AMOUNT;
                }
                amount = safeAmount;

                // 【立即執行，不再設置任何前置閘門】實測證實 .betBtn 的 display:none/disabled
                // 是「點擊該格後才彈出的確認小視窗」原始待命狀態，並非「本局是否開放下注」的
                // 全域指標；若在此處等待其解鎖，只會平白拖慢下注速度、錯過下注視窗，
                // 故直接依安全閥校正後的金額拆解並執行點擊佇列，維持與真人操作相同的即時性。
                const chipPlan = decomposeAmountToChips(amount);
                if (chipPlan.length === 0) {
                    console.warn('[自動下注] 無法將金額拆解為任何可用籌碼面額，已略過本次下注。amount=' + amount);
                    return;
                }
                console.log(
                    `[自動下注] 金額 ${amount} 元拆解為籌碼組合：` +
                    chipPlan.map(item => `${item.denomination}元 x${item.count}`).join('、')
                );

                const actionQueue = buildBetActionQueue(chipPlan);
                runBetActionQueue(actionQueue, 0, direction, amount, () => {
                    // 佇列全部執行完畢（含最終確認送出步驟），本次下注流程結束。
                });
            } catch (error) {
                console.warn('[自動下注] placeRealBet 發生例外，已安全略過：', error);
            }
        }
    };

    if (typeof window !== 'undefined') {
        try {
            window.MTAutoBetManager = AutoBetManager;
        } catch (error) {
            /* 靜默失敗，不阻斷頁面其餘功能 */
        }
    }
})();
