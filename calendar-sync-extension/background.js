const FLASK_BACKEND_URL = 'http://localhost:5001';
// !!! QUAN TRỌNG: Đảm bảo pattern này khớp chính xác với phần đầu URL trang TKB MyUEL !!!
const MYUEL_TKB_URL_PATTERN = 'https://myuel.uel.edu.vn/Default.aspx?PageId='; // <<< KIỂM TRA LẠI GIÁ TRỊ NÀY
// --- ID CỦA CÁC PHẦN TỬ HTML TRÊN TRANG MYUEL (Cần kiểm tra lại) ---
const WEEK_DROPDOWN_ID = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan"; // <<< ID ĐÚNG LÀ ddlTuan
// --- Định nghĩa các chuỗi ID để truyền đi ---
const TIMETABLE_TABLE_ID_STRING = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_tblThoiKhoaBieu";
const DATE_SPAN_ID_STRING = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_lblDate";
// -----------------------------------------------------------
let GOOGLE_CLIENT_ID = '';
let GOOGLE_SCOPES = '';
try {
    const manifest = chrome.runtime.getManifest();
    GOOGLE_CLIENT_ID = manifest?.oauth2?.client_id;
    GOOGLE_SCOPES = manifest?.oauth2?.scopes?.join(' ');
    if (!GOOGLE_CLIENT_ID || !GOOGLE_SCOPES || GOOGLE_CLIENT_ID.includes("YOUR_")) {
        throw new Error("Client ID/Scopes chưa cấu hình đúng trong manifest.json");
    }
} catch (e) {
    console.error("BG ERROR: Init manifest failed.", e);
}
// ---------------

const logger = {
    info: (...args) => console.log("[BACKGROUND INFO]", new Date().toISOString(), ...args),
    warn: (...args) => console.warn("[BACKGROUND WARN]", new Date().toISOString(), ...args),
    error: (...args) => console.error("[BACKGROUND ERROR]", new Date().toISOString(), ...args),
    debug: (...args) => console.debug("[BACKGROUND DEBUG]", new Date().toISOString(), ...args)
};

// --- Hàm Hiển Thị Thông Báo Hệ Thống ---
function showNotification(title, message, type = 'basic', idSuffix = Date.now().toString()) {
     const notificationId = `uel-sync-notif-${idSuffix}`;
     let iconUrl = 'icon.png'; // Đảm bảo file icon.png tồn tại ở thư mục gốc
     logger.debug(`BG: Showing notification: Id=${notificationId}, Title='${title}', Msg='${message}'`);
     chrome.notifications.create(notificationId, { type: 'basic', iconUrl: iconUrl, title: title, message: message, priority: 1 }, (id) => { if (chrome.runtime.lastError) logger.error("BG: Notif Create Error:", chrome.runtime.lastError?.message); else logger.debug("BG: Notification created ID:", id); });
}

// --- Hàm Lấy Google Access Token qua launchWebAuthFlow ---
function forceGoogleLoginAndGetToken(userIdHint) {
    logger.info("BG: --- ENTERING forceGoogleLoginAndGetToken ---");
    logger.debug("BG: >> userIdHint:", userIdHint);
    return new Promise((resolve, reject) => {
        logger.debug("BG: >> Inside forceGoogleLoginAndGetToken Promise.");
        logger.debug(`BG: >> Using GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}`);
        logger.debug(`BG: >> Using GOOGLE_SCOPES: ${GOOGLE_SCOPES}`);
        if (!GOOGLE_CLIENT_ID || !GOOGLE_SCOPES || GOOGLE_CLIENT_ID.includes("YOUR_")) { const errorMsg = "Chưa cấu hình đúng Client ID hoặc Scopes trong manifest."; logger.error("BG: >> Validation failed:", errorMsg); showNotification("Lỗi Cấu Hình", errorMsg, 'error', 'cfg_err_token'); return reject(new Error(errorMsg)); }
        try {
            logger.debug("BG: >> Attempting chrome.identity.getRedirectURL...");
            const calculatedRedirectUri = chrome.identity.getRedirectURL("google");
            logger.info("BG: >> Successfully got Redirect URI:", calculatedRedirectUri);
            const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID); authUrl.searchParams.set('response_type', 'token');
            authUrl.searchParams.set('redirect_uri', calculatedRedirectUri); authUrl.searchParams.set('scope', GOOGLE_SCOPES);
            authUrl.searchParams.set('prompt', 'consent select_account'); if (userIdHint) { authUrl.searchParams.set('login_hint', userIdHint); }
            const finalAuthUrl = authUrl.toString();
            logger.info("BG: >> Launching Web Auth Flow:", finalAuthUrl);
            chrome.identity.launchWebAuthFlow( { url: finalAuthUrl, interactive: true }, (redirectUrl) => {
                logger.debug("BG: >> launchWebAuthFlow callback executed.");
                if (chrome.runtime.lastError || !redirectUrl) { logger.error("BG: >> launchWebAuthFlow API Error or Cancelled:", chrome.runtime.lastError); reject(new Error(chrome.runtime.lastError?.message || "Xác thực Google thất bại/bị hủy bỏ.")); }
                else { logger.info("BG: >> Auth flow successful, parsing redirect URL."); try { const params = new URLSearchParams(redirectUrl.substring(redirectUrl.indexOf('#') + 1)); const accessToken = params.get('access_token'); const error = params.get('error'); logger.debug("BG: >> Parsed params:", Object.fromEntries(params)); if (error) { logger.error("BG: >> Google returned error:", error); reject(new Error(`Lỗi từ Google: ${error}`)); } else if (!accessToken) { logger.error("BG: >> No access token in fragment:", redirectUrl); reject(new Error("Không tìm thấy access token.")); } else { logger.info("BG: >> Access Token extracted OK."); resolve(accessToken); } } catch (parseError) { logger.error("BG: >> Error parsing redirect:", parseError); reject(new Error("Lỗi xử lý phản hồi Google.")); } }
            });
        } catch (error) { logger.error("BG: >> Error during setup before launchWebAuthFlow:", error); reject(new Error(`Lỗi thiết lập xác thực extension: ${error.message}`)); }
    });
}

// --- Hàm Gọi API Backend Flask ---
async function fetchBackendWithAuth(endpoint, method = 'GET', accessToken, body = null) {
    if (!accessToken) { logger.error("BG: fetchBackend: No accessToken."); throw new Error("Thiếu access token."); } try { const options = { method: method, headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }; if (body && method !== 'GET' && method !== 'HEAD') { options.body = JSON.stringify(body); } const targetUrl = `${FLASK_BACKEND_URL}${endpoint}`; logger.debug(`BG: Fetching: ${method} ${targetUrl}`); const response = await fetch(targetUrl, options); let responseData = {}; try { responseData = await response.json(); } catch (e) { if (!response.ok) throw { status: response.status, message: `HTTP Error ${response.status}`}; } if (!response.ok) { logger.error(`BG: Backend Error: ${response.status}`, responseData); throw { status: response.status, message: responseData?.error || `HTTP Error ${response.status}`, data: responseData }; } logger.info("BG: Backend response OK."); return responseData; } catch (error) { logger.error(`BG: Fetch Error to ${endpoint}:`, error); throw error; }
}

// --- Hàm DELAY ---
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// --- Hàm inject script và lấy kết quả ---
async function executeScriptOnTab(tabId, funcOrFile, args = []) {
     const target = { tabId: tabId }; const injection = {}; if (typeof funcOrFile === 'function') { injection.func = funcOrFile; injection.args = args; injection.world = "MAIN"; } else if (typeof funcOrFile === 'string' && funcOrFile.endsWith('.js')) { injection.files = [funcOrFile]; } else { throw new Error("Invalid funcOrFile"); } logger.debug(`BG: Executing script on tab ${tabId}`, injection); try { const results = await chrome.scripting.executeScript({ target: target, ...injection }); logger.debug(`BG: Script result:`, results); if (!results || results.length === 0) throw new Error(`Script no result frame.`); if (results[0].result === undefined || results[0].result === null) { if(results[0].error) throw new Error(`Frame script error: ${results[0].error.message||results[0].error}`); return null; } return results[0].result; } catch (err) { logger.error(`BG: Error executing script on tab ${tabId}:`, err); throw new Error(`Lỗi chạy script: ${err.message}`); }
}

// --- Các hàm chạy trong Content Script Context ---
function getContent_getWeekOptions(dropdownId) {
     const weekDropdown = document.getElementById(dropdownId); if (!weekDropdown) { console.error(`[CS] Dropdown ID '${dropdownId}' not found!`); return { error: `Dropdown tuần ID '${dropdownId}' không thấy!` }; } const options = []; for (let i = 0; i < weekDropdown.options.length; i++) { const option = weekDropdown.options[i]; if (option.value && option.value !== "-1" && option.value !== "") { options.push({ value: option.value, text: option.text }); } } console.log(`[CS] Found ${options.length} week options.`); return options;
 }
// Hàm này sẽ được inject để chọn tuần, chờ và lấy data
async function getContent_selectWeekAndGetData(dropdownId, weekValue, tableId, dateId) {
    console.log(`[CS] Selecting week value: ${weekValue}`);
    const weekDropdown = document.getElementById(dropdownId);
    const timetableTable = document.getElementById(tableId);
    const dateSpan = document.getElementById(dateId);

    if (!weekDropdown || !timetableTable || !dateSpan) { let missing = []; if (!weekDropdown) missing.push(`Dropdown ID ${dropdownId}`); if (!timetableTable) missing.push(`Table ID ${tableId}`); if (!dateSpan) missing.push(`Date ID ${dateId}`); console.error("[CS] Missing elements:", missing); return { error: `Thiếu phần tử: ${missing.join(', ')}` }; }

    const oldDateText = dateSpan.innerText.trim(); // Lưu lại text ngày cũ
    weekDropdown.value = weekValue;
    console.log("[CS] Dispatching change event...");
    weekDropdown.dispatchEvent(new Event('change', { bubbles: true }));

    // --- LOGIC CHỜ ĐỢI ĐỘNG ---
    const checkInterval = 300; // ms - Tần suất kiểm tra
    const timeoutMs = 8000; // ms - Thời gian chờ tối đa (8 giây)
    const endTime = Date.now() + timeoutMs;
    let dateChanged = false;
    console.log(`[CS Wait] Waiting for date change from "${oldDateText}" (max ${timeoutMs}ms)`);

    while (Date.now() < endTime) {
        const currentDateSpan = document.getElementById(dateId); // Lấy lại tham chiếu phòng khi bị thay thế
        if (!currentDateSpan) {
             console.warn("[CS Wait] Date span disappeared during wait.");
             await new Promise(r => setTimeout(r, checkInterval)); // Chờ chút rồi thử lại
             continue;
        }
        const newDateText = currentDateSpan.innerText.trim();
        // Kiểm tra xem text đã thay đổi và không rỗng
        if (newDateText && newDateText !== oldDateText) {
            console.log(`[CS Wait] Date changed to "${newDateText}". Update detected.`);
            dateChanged = true;
            break; // Thoát vòng lặp chờ
        }
        await new Promise(r => setTimeout(r, checkInterval)); // Chờ trước khi kiểm tra lại
    }

    if (!dateChanged) {
        console.warn(`[CS Wait] Timeout waiting for date text to change from "${oldDateText}". Proceeding anyway.`);
        // Không ném lỗi ở đây, vẫn thử lấy dữ liệu xem sao
    }
    // --- KẾT THÚC LOGIC CHỜ ĐỢI ĐỘNG ---

    // Lấy dữ liệu sau khi chờ (hoặc timeout)
    const finalTimetableTable = document.getElementById(tableId);
    const finalDateSpan = document.getElementById(dateId);

    if (!finalTimetableTable || !finalDateSpan) { return { error: "Element lỗi sau khi chờ update." }; }

    const timetableHtml = finalTimetableTable.outerHTML;
    const dateRangeText = finalDateSpan.innerText.trim();

    if (!timetableHtml || !dateRangeText) { return { error: "Không trích xuất được data sau khi chờ." }; }

    console.log(`[CS] Successfully extracted data for week value ${weekValue}. Date range: ${dateRangeText}`);
    return { timetableHtml: timetableHtml, dateRangeText: dateRangeText };
}

// --- HÀM XỬ LÝ ĐỒNG BỘ TUẦN ---
async function handleSingleWeekSync(userId, tabId, sendResponse) {
     logger.info(`BG: Starting SINGLE WEEK sync for user: ${userId} on tab ${tabId}`);
     let accessToken = null; const notificationTitle = "Đồng bộ Tuần Hiện tại";
     let finalStatus = { status: "error", message: "Lỗi không xác định (Tuần)." };

     if (!tabId) { logger.error("BG: Missing target tabId."); finalStatus = { status: "error", message: "Lỗi: Không có Tab ID." }; showNotification(notificationTitle + " - LỖI", finalStatus.message, 'error', 'week-notabid'); try { if(typeof sendResponse === 'function') sendResponse(finalStatus); } catch(e){} return; }

     try {
         logger.info("BG: (Week) Getting token..."); showNotification(notificationTitle, "Đang yêu cầu quyền Google...", 'basic', 'week-auth');
         try { accessToken = await forceGoogleLoginAndGetToken(userId); logger.info("BG: (Week) Token raw:", accessToken); if (!accessToken) throw new Error("Token không hợp lệ."); logger.info("BG: (Week) Token OK."); }
         catch (tokenError) { logger.error(`BG: (Week) FAILED get token:`, tokenError); throw tokenError; }

         showNotification(notificationTitle, "Đang lấy dữ liệu TKB...", 'basic', 'week-scrape'); logger.debug("BG: Getting target tab details:", tabId); const targetTab = await chrome.tabs.get(tabId); if (!targetTab) throw new Error(`Tab ID ${tabId} không tồn tại.`); const currentUrl = targetTab.url; logger.info("BG: Target tab URL (Week):", currentUrl || "[No URL]");
         if (!currentUrl || !currentUrl.startsWith(MYUEL_TKB_URL_PATTERN)) { let urlDesc = currentUrl ? currentUrl.substring(0, 80) + "..." : "https://www.merriam-webster.com/dictionary/invalid"; throw new Error(`Tab (${urlDesc}) không phải TKB MyUEL.`); }
         logger.info("BG: URL check OK (Week)."); const targetTabId = targetTab.id; logger.debug("BG: Injecting script (Week)..."); let injectionResults;
         // Sửa lại: Inject file content.js chuẩn
         try { injectionResults = await executeScriptOnTab(targetTabId, 'content.js'); } // <<< Dùng files thay vì func
         catch(scriptError) { throw new Error(`Lỗi inject script (Tuần): ${scriptError.message}`); }
         logger.debug("BG: Script inject result (Week):", injectionResults);
         // Helper đã trả về result trực tiếp
         if (!injectionResults) throw new Error("content.js không trả về kết quả hoặc lỗi (Tuần).");
         const extractedData = injectionResults; // Không cần .result nữa nếu helper trả về trực tiếp
         if (extractedData.error) throw new Error(`Lỗi content.js (Tuần): ${extractedData.error}`);
         if (!extractedData.timetableHtml || !extractedData.dateRangeText) throw new Error("content.js thiếu data (Tuần).");
         logger.info("BG: Extracted data OK (Week).");

         showNotification(notificationTitle, "Đang gửi dữ liệu...", 'basic', 'week-sync'); const syncPayload = { user_id: userId, timetable_html: extractedData.timetableHtml, date_range_text: extractedData.dateRangeText }; const syncResult = await fetchBackendWithAuth('/sync_from_extension', 'POST', accessToken, syncPayload); logger.info("BG: Backend call OK (Week). Result:", JSON.stringify(syncResult || {}, null, 2));

         let finalMessage = "Đồng bộ tuần hoàn tất."; let notificationType = 'success';
         if (syncResult && typeof syncResult === 'object') { /* ... xử lý syncResult ... */ finalMessage = syncResult.message || 'Đồng bộ thành công!'; const errorsReported = syncResult.errors ?? 0; if (errorsReported > 0) { notificationType = 'warning'; finalMessage = `Hoàn tất lỗi: Thêm ${syncResult.added ?? 0}, Skip ${syncResult.skipped ?? 0}, Lỗi ${errorsReported}.`; } else if (syncResult.added !== undefined) { finalMessage = `Tuần ${syncResult.week ?? 'N/A'}: Thêm ${syncResult.added ?? 0}, Skip ${syncResult.skipped ?? 0}, Lỗi ${errorsReported}.`; } if (syncResult.processing_time !== undefined) { finalMessage += ` (${syncResult.processing_time}s)`; } finalStatus = { status: "success", message: finalMessage }; } else { logger.error("BG: Invalid backend result (Week):", syncResult); finalMessage = "Phản hồi server lỗi."; notificationType = 'error'; finalStatus = { status: "error", message: finalMessage }; }
         logger.debug("BG: Prep final notification (Week)."); showNotification(notificationTitle + (notificationType === 'success' ? " - Hoàn tất" : " - Chú ý"), finalMessage, notificationType, 'week-done');
     } catch (error) { logger.error("BG: --- SINGLE WEEK SYNC FAILED ---", error); let errorMsg = 'Lỗi đồng bộ tuần: '; errorMsg += error?.message || 'Lỗi không xác định.'; showNotification(notificationTitle + " - LỖI", errorMsg, 'error', 'week-error'); finalStatus = { status: "error", message: errorMsg };
     } finally { logger.info("BG: Single week sync process finished."); try { if (typeof sendResponse === 'function') { sendResponse(finalStatus); } } catch (e) { logger.warn("BG: Error calling sendResponse (Week):", e.message); } }
}

// --- HÀM XỬ LÝ ĐỒNG BỘ HỌC KỲ (Logic Pre-select + Loop All) ---
async function handleSemesterSync(userId, sendResponse) {
    logger.info(`BG: Starting SEMESTER sync process for user: ${userId}`);
    let accessToken = null; const notificationTitle = "Đồng bộ Học kỳ UEL";
    let overallResult = { added: 0, skipped: 0, errors: 0, weeksProcessed: 0, weeksTotal: 0 };
    let finalStatus = { status: "error", message: "Lỗi khởi tạo đồng bộ học kỳ." };
    let consecutiveEmptyWeeks = 0; const CONSECUTIVE_EMPTY_WEEKS_LIMIT = 8;
    const PAGE_LOAD_WAIT_MS = 4500; // Chờ sau khi chọn tuần
    const INTER_WEEK_DELAY_MS = 500; // Chờ giữa các tuần
    const PRESELECT_WAIT_MS = 4000; // Chờ sau khi chọn trước tuần 2

    try {
        // Bước 1: Lấy Token
        showNotification(notificationTitle, "Bắt đầu: Yêu cầu quyền Google...", 'basic', 'sem-auth');
        try { accessToken = await forceGoogleLoginAndGetToken(userId); if (!accessToken) throw new Error("Token không hợp lệ."); logger.info("BG: (Semester) Token OK."); }
        catch (tokenError) { logger.error(`BG: (Semester) FAILED get token:`, tokenError); throw tokenError; }

        // Bước 2: Tìm tab TKB
        showNotification(notificationTitle, "Đang tìm tab TKB...", 'basic', 'sem-findtab');
        const matchingTabs = await chrome.tabs.query({ url: MYUEL_TKB_URL_PATTERN + "*" });
        if (!matchingTabs || matchingTabs.length === 0) throw new Error(`Không tìm thấy tab TKB MyUEL.`);
        if (matchingTabs.length > 1) logger.warn(`BG: Found ${matchingTabs.length} TKB tabs. Using first.`);
        const targetTabId = matchingTabs[0].id; logger.info(`BG: Found target TKB tab: ID=${targetTabId}`);

        // Bước 3: Lấy danh sách tuần
        showNotification(notificationTitle, "Đang lấy danh sách tuần...", 'basic', 'sem-getweeks');
        const weekOptionsRaw = await executeScriptOnTab(targetTabId, getContent_getWeekOptions, [WEEK_DROPDOWN_ID]);
        if (weekOptionsRaw.error || !Array.isArray(weekOptionsRaw)) { throw new Error(weekOptionsRaw.error || "Không lấy được danh sách tuần."); }
        const weekOptions = weekOptionsRaw.filter(option => option.value !== '0'); // Lọc tuần "Tất cả"
        logger.info(`BG: Found ${weekOptions.length} valid weeks.`);
        if (weekOptions.length === 0) { throw new Error("Không tìm thấy tuần hợp lệ nào."); }
        overallResult.weeksTotal = weekOptions.length;

        // --- BƯỚC 3.5: CHỌN TRƯỚC TUẦN 2 (NẾU CÓ) ---
        // Mục đích: Đưa trang ra khỏi trạng thái mặc định của Tuần 1 trước khi bắt đầu vòng lặp
        if (weekOptions.length > 1) {
            const secondWeekValue = weekOptions[1].value; // Lấy value của tuần thứ hai
            logger.info(`BG: Pre-selecting week 2 (value: ${secondWeekValue}) to ensure proper state change...`);
            showNotification(notificationTitle, `Đang chuẩn bị (tải trước tuần 2)...`, 'basic', `sem-preselect`);
            try {
                // Chỉ cần chọn và chờ, không cần lấy data ở bước này
                await executeScriptOnTab(
                    targetTabId,
                    async (dropdownId, weekVal) => { // Hàm inline để chỉ chọn và dispatch event
                         const dd = document.getElementById(dropdownId);
                         if(dd) { dd.value = weekVal; dd.dispatchEvent(new Event('change', { bubbles: true })); console.log(`[CS PreSelect] Dispatched change for ${weekVal}`);}
                         else { console.error(`[CS PreSelect] Dropdown ${dropdownId} not found!`);}
                     },
                     [WEEK_DROPDOWN_ID, secondWeekValue]
                );
                logger.debug(`BG: Pre-selection dispatched. Waiting ${PRESELECT_WAIT_MS}ms...`);
                await delay(PRESELECT_WAIT_MS); // Chờ trang xử lý xong
                logger.info("BG: Pre-selection of week 2 likely complete.");
            } catch (preSelectError) {
                // Nếu bước này lỗi cũng không nên dừng hẳn, vòng lặp sau có thể vẫn hoạt động
                logger.error("BG: Failed during pre-selection of week 2", preSelectError);
                showNotification(notificationTitle + " - Cảnh báo", `Lỗi khi tải trước tuần 2: ${preSelectError.message}`, 'warning', `sem-preselect-err`);
            }
        }
        // --- KẾT THÚC CHỌN TRƯỚC ---

        // --- Vòng lặp xử lý TẤT CẢ các tuần (từ index 0) ---
        for (let i = 0; i < weekOptions.length; i++) { // <<< BẮT ĐẦU TỪ i = 0
            // Kiểm tra dừng sớm
            if (consecutiveEmptyWeeks >= CONSECUTIVE_EMPTY_WEEKS_LIMIT) { logger.warn(`BG: Stop early: ${consecutiveEmptyWeeks} empty weeks.`); showNotification(notificationTitle, `Dừng sớm do ${CONSECUTIVE_EMPTY_WEEKS_LIMIT} tuần trống.`, 'info', `sem-stop`); break; }

            const week = weekOptions[i];
            // Hiển thị đúng số tuần (i+1)
            const progressMsg = `Tuần ${i + 1}/${weekOptions.length}: ${week.text}`;
            logger.info(`BG: ----- Processing ${progressMsg} -----`);
            showNotification(notificationTitle, `Đang xử lý ${progressMsg}...`, 'basic', `sem-week-${i}`);
            let extractedData = null;

            try {
                 logger.debug(`BG: Attempting select week '${week.value}' and extract data...`);
                 // Gọi hàm kết hợp chọn tuần, chờ, lấy data
                 extractedData = await executeScriptOnTab(
                     targetTabId,
                     getContent_selectWeekAndGetData, // Hàm này chọn, dispatch, chờ, lấy data
                     [
                         WEEK_DROPDOWN_ID,
                         week.value,
                         TIMETABLE_TABLE_ID_STRING,
                         DATE_SPAN_ID_STRING
                     ]
                 );
                 if (extractedData.error) { throw new Error(extractedData.error); }
                 if (!extractedData || !extractedData.timetableHtml || !extractedData.dateRangeText) { throw new Error("Không nhận đủ dữ liệu từ content script chọn tuần."); }
                 logger.info(`BG: Extracted data for week: ${week.text}`);

            } catch (extractOrSelectError) {
                 logger.error(`BG: Fail processing week ${week.text}`, extractOrSelectError);
                 overallResult.errors++;
                 showNotification(notificationTitle + " - Lỗi Tuần", `Lỗi xử lý tuần ${week.text}: ${extractOrSelectError.message}`, 'error', `sem-week-err-${i}`);
                 consecutiveEmptyWeeks = 0; // Reset vì tuần lỗi
                 await delay(1000); // Chờ chút trước khi sang tuần tiếp
                 continue; // Bỏ qua tuần lỗi
            }

            // Gửi dữ liệu tuần này đến Backend
            showNotification(notificationTitle, `Đang gửi dữ liệu tuần ${i+1}...`, 'basic', `sem-sync-${i}`);
            const syncPayload = { user_id: userId, timetable_html: extractedData.timetableHtml, date_range_text: extractedData.dateRangeText };
            try {
                const syncResult = await fetchBackendWithAuth('/sync_from_extension', 'POST', accessToken, syncPayload);
                logger.info(`BG: Backend response week ${week.text}:`, JSON.stringify(syncResult || {}, null, 2));
                // Cập nhật kết quả tổng và biến đếm tuần trống
                if (syncResult && typeof syncResult === 'object') { const a=syncResult.added??0; const s=syncResult.skipped??0; const e=syncResult.errors??0; overallResult.added+=a; overallResult.skipped+=s; overallResult.errors+=e; if(a===0&&s===0&&e===0) consecutiveEmptyWeeks++; else consecutiveEmptyWeeks=0; logger.info(`BG: Empty week (${week.text}) check. Count: ${consecutiveEmptyWeeks}`); } else { overallResult.errors++; consecutiveEmptyWeeks=0; }
            } catch (backendError) { logger.error(`BG: Backend error week ${week.text}`, backendError); overallResult.errors++; consecutiveEmptyWeeks=0; let bErrorMsg = backendError.message || "Lỗi"; if(backendError.status === 401) bErrorMsg = "Token Google hết hạn."; showNotification(notificationTitle + " - Lỗi Backend", `Lỗi đồng bộ tuần ${week.text}: ${bErrorMsg}`, 'error', `sem-be-err-${i}`); if(backendError.status === 401) { throw new Error("Token Google không hợp lệ."); } }
            overallResult.weeksProcessed++; // Tăng số tuần đã xử lý (trong vòng lặp)
            logger.debug(`BG: Delay ${INTER_WEEK_DELAY_MS}ms...`); await delay(INTER_WEEK_DELAY_MS); // Delay ngắn giữa các tuần
        } // End for loop

        // Tạo thông báo tổng kết cuối cùng
        // Tổng số tuần xử lý = số tuần chạy trong vòng lặp (kể cả lỗi)
        let finalSummary = `Học kỳ hoàn tất! Đã xử lý ${overallResult.weeksProcessed}/${overallResult.weeksTotal} tuần.`; // Tổng số tuần xử lý bao gồm cả lỗi
        finalSummary += ` Tổng cộng: Thêm ${overallResult.added}, Bỏ qua ${overallResult.skipped}, Lỗi ${overallResult.errors}.`;
        if (consecutiveEmptyWeeks >= CONSECUTIVE_EMPTY_WEEKS_LIMIT) { finalSummary += ` Đã dừng sớm do ${CONSECUTIVE_EMPTY_WEEKS_LIMIT} tuần trống.` }
        logger.info("BG:", finalSummary);
        showNotification(notificationTitle + " - Hoàn tất", finalSummary, (overallResult.errors > 0 ? 'warning' : 'success'), 'sem-done');
        finalStatus = { status: "success", message: finalSummary };

    } catch (error) { // Bắt lỗi tổng thể của cả quá trình
        logger.error("BG: --- SEMESTER SYNC FAILED ---", error); let errorMsg = 'Lỗi đồng bộ học kỳ: '; errorMsg += error?.message || 'Lỗi không xác định.'; showNotification(notificationTitle + " - LỖI NGHIÊM TRỌNG", errorMsg, 'error', 'sem-error-final'); finalStatus = { status: "error", message: errorMsg };
    } finally { // Gửi phản hồi về popup
        logger.info("BG: Semester sync handleSemesterSync finished.");
        try { if (typeof sendResponse === 'function') { sendResponse(finalStatus); } } catch (e) { logger.warn("BG: Error calling sendResponse (Semester):", e.message); }
    }
}



// --- Listener chính ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    logger.debug("BG: Message received", message);
    if (message.action === "startSync") {
        const userId = message.userId; const targetTabId = message.tabId;
        if (!userId || !targetTabId) { logger.error("BG: Week Sync req missing info."); sendResponse({status:"error", message:"Thiếu UserID hoặc TabID."}); return false; }
        handleSingleWeekSync(userId, targetTabId, sendResponse);
        return true;
    } else if (message.action === "startSemesterSync") {
        const userId = message.userId;
        if (!userId) { logger.error("BG: Semester Sync req no userId."); sendResponse({status:"error", message:"Thiếu User ID."}); return false; }
        handleSemesterSync(userId, sendResponse);
        return true;
    }
});

// Log khởi động
logger.info("Background service worker started and listener added.");
