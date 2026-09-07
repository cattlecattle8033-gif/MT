// ==UserScript==
// @name         龍盈科技【MT百家樂】專業設計精裝版
// @namespace    http://tampermonkey.net
// @version      62.0.0
// @description  龍盈科技 MT 百家樂即時局勢統計、凱利公式動態注碼與高階路則分析面板
// @author       龍盈研發團隊
// @match        *://*.ofalive99.net/*
// @match        *://gsa.ofalive99.net/*
// @run-at       document-start
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/cattlecattle8033-gif/MT/refs/heads/main/installer.user.js
// @downloadURL  https://raw.githubusercontent.com/cattlecattle8033-gif/MT/refs/heads/main/installer.user.js
// @require      https://raw.githubusercontent.com/cattlecattle8033-gif/MT/refs/heads/main/MT_Baccarat_Source.js
// ==UserScript==

(function() {
    'use strict';
    // 企業級跨平台主控台簽名 - 完美主義細節打磨
    const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    const deviceTag = isMobile ? ' 行動端相容模式 ' : ' 桌面端優化模式 ';
    const brandStyle = 'background: #121214; color: #e0474c; padding: 4px 8px; border-radius: 4px 0 0 4px; font-weight: bold; border: 1px solid rgba(255,255,255,0.08);';
    const coreStyle = 'background: rgba(47,105,227,0.1); color: #2f69e3; padding: 4px 8px; border-radius: 0 4px 4px 0; font-weight: bold; border: 1px solid rgba(47,105,227,0.2); border-left: none;';
    console.log(`%c[龍盈科技]%c頂級量子計算與動態防禦模組已成功加載 (${deviceTag})。`, brandStyle, coreStyle);
})();
