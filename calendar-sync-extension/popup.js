// Calendar-sync/Calendar-sync-extension/popup.js

const userIdInput = document.getElementById('userId');
const syncWeekButton = document.getElementById('syncWeekButton');
const syncSemesterButton = document.getElementById('syncSemesterButton');
const statusDiv = document.getElementById('status');

// --- Cấu hình (Cần định nghĩa pattern ở đây để popup kiểm tra) ---
const MYUEL_TKB_URL_PATTERN = 'https://myuel.uel.edu.vn/Default.aspx?PageId='; // <<< Cần giống background.js
// --------------------------------------------------------------------

const logger = { info: (...args) => console.log("[POPUP INFO]", ...args), warn: (...args) => console.warn("[POPUP WARN]", ...args), error: (...args) => console.error("[POPUP ERROR]", ...args), debug: (...args) => console.debug("[POPUP DEBUG]", ...args) };

function updateStatus(message, type = 'info') {
    statusDiv.textContent = message;
    statusDiv.className = type;
    const processing = (type === 'info' && (message.includes('Đang gửi') || message.includes('Đang xử lý')));
    syncWeekButton.disabled = processing;
    syncSemesterButton.disabled = processing;
}

// Load/Save User ID
document.addEventListener('DOMContentLoaded', () => { /* ... Giữ nguyên ... */ });
userIdInput.addEventListener('input', () => { /* ... Giữ nguyên ... */ });

// --- SỰ KIỆN NÚT ĐỒNG BỘ TUẦN HIỆN TẠI (SỬA LẠI) ---
syncWeekButton.addEventListener('click', async () => { // <<< Thêm async
    logger.info("Sync Week button clicked.");
    const userId = userIdInput.value.trim();
    if (!userId || !userId.includes('@st.uel.edu.vn')) { updateStatus('Vui lòng nhập đúng email sinh viên UEL.', 'error'); userIdInput.focus(); return; }
    chrome.storage.local.set({ userId: userId });

    updateStatus('Đang kiểm tra tab hiện tại...', 'info');
    syncWeekButton.disabled = true;
    syncSemesterButton.disabled = true;

    try {
        // --- KIỂM TRA TAB TRƯỚC KHI GỬI MESSAGE ---
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!currentTab) {
             throw new Error("Không tìm thấy tab đang hoạt động.");
        }
        logger.info("Popup: Current active tab:", currentTab.id, currentTab.url);
        if (!currentTab.url || !currentTab.url.startsWith(MYUEL_TKB_URL_PATTERN)) {
            throw new Error(`Bạn cần mở đúng trang TKB MyUEL (URL bắt đầu bằng ${MYUEL_TKB_URL_PATTERN}) trên tab hiện tại trước khi đồng bộ tuần.`);
        }
        const targetTabId = currentTab.id; // Lấy ID tab hợp lệ
        // --- KẾT THÚC KIỂM TRA TAB ---

        updateStatus('Tab hợp lệ. Đang gửi yêu cầu đồng bộ tuần...', 'info');

        // Gửi message đến background script KÈM THEO targetTabId
        chrome.runtime.sendMessage(
            {
                action: "startSync", // Action cũ
                userId: userId,
                tabId: targetTabId // <<< Gửi ID của tab cần xử lý
            },
            (response) => {
                 if (chrome.runtime.lastError) { logger.error("Error sending/receiving message (Week):", chrome.runtime.lastError); updateStatus(`Lỗi giao tiếp (Tuần): ${chrome.runtime.lastError.message}`, 'error'); }
                 else if (response?.status === "success") { logger.info("Background success (Week):", response.message); updateStatus(response.message, 'success'); }
                 else if (response?.status === "error") { logger.error("Background error (Week):", response.message); updateStatus(response.message, 'error'); }
                 else { logger.warn("Unexpected response (Week):", response); updateStatus("Phản hồi không xác định.", 'warn'); }
                 // Bật lại nút
                 syncWeekButton.disabled = false;
                 syncSemesterButton.disabled = false;
            }
        );
    } catch (error) {
        logger.error("Error before sending message (Week):", error);
        updateStatus(`Lỗi: ${error.message}`, 'error');
        syncWeekButton.disabled = false;
        syncSemesterButton.disabled = false;
    }
});

// --- SỰ KIỆN NÚT ĐỒNG BỘ CẢ HỌC KỲ (Giữ nguyên logic gửi message) ---
syncSemesterButton.addEventListener('click', () => {
    logger.info("Sync Semester button clicked.");
    const userId = userIdInput.value.trim();
    if (!userId || !userId.includes('@st.uel.edu.vn')) { updateStatus('Vui lòng nhập đúng email sinh viên UEL.', 'error'); userIdInput.focus(); return; }
    chrome.storage.local.set({ userId: userId });

    updateStatus('Đang gửi yêu cầu đồng bộ học kỳ...', 'info');
    syncWeekButton.disabled = true;
    syncSemesterButton.disabled = true;

    chrome.runtime.sendMessage(
        { action: "startSemesterSync", userId: userId }, // Action mới
        (response) => { // Callback xử lý phản hồi
             if (chrome.runtime.lastError) { logger.error("Error sending/receiving message (Semester):", chrome.runtime.lastError); updateStatus(`Lỗi giao tiếp (Học kỳ): ${chrome.runtime.lastError.message}`, 'error'); }
             else if (response?.status === "success") { logger.info("Background success (Semester):", response.message); updateStatus(response.message, 'success'); }
             else if (response?.status === "error") { logger.error("Background error (Semester):", response.message); updateStatus(response.message, 'error'); }
             else { logger.warn("Unexpected response (Semester):", response); updateStatus("Phản hồi không xác định.", 'warn'); }
             // Bật lại nút
             syncWeekButton.disabled = false;
             syncSemesterButton.disabled = false;
        }
    );
});

// --- Listener của nút logout đã bị xóa ---