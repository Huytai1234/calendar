# Calendar-sync/app.py
# -*- coding: utf-8 -*-
# Phiên bản: Sửa lỗi thụt lề, tối ưu Batch, chuẩn bị cho Production

from flask import Flask, render_template, request, session, jsonify
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.oauth2.credentials import Credentials
from bs4 import BeautifulSoup
import time
import re
import os # Đảm bảo đã import os
import pickle
import logging
from datetime import datetime, timedelta, timezone
from werkzeug.wrappers import Response
import json
import pprint
# --- THÊM IMPORT CORS ---
from flask_cors import CORS
# -----------------------


# --- Cấu hình cơ bản ---
# os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1' # <<< DÒNG NÀY ĐÃ ĐƯỢC COMMENT OUT HOẶC XÓA
app = Flask(__name__)

# --- KÍCH HOẠT CORS ---
# !!! THAY THẾ ID EXTENSION CỦA BẠN VÀO ĐÂY KHI CẦN !!! (Giữ nguyên nếu ID là đúng)
EXTENSION_ID = "oolaaglnbllindgkiibpeemmojgflenc" # Lấy từ chrome://extensions
EXTENSION_ORIGIN = f"chrome-extension://{EXTENSION_ID}"
CORS(app, resources={ r"/sync_from_extension": {"origins": EXTENSION_ORIGIN} })
# Khởi tạo logger sau khi import logging
logger = logging.getLogger(__name__)
logger.info(f"CORS enabled for origin: {EXTENSION_ORIGIN}")
# ---------------------

# !!! SỬ DỤNG BIẾN MÔI TRƯỜNG CHO SECRET KEY !!!
app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'ban-can-thiet-lap-bien-moi-truong-FLASK_SECRET_KEY') # <<< ĐÃ THAY ĐỔI

# Cấu hình logging (Giữ nguyên hoặc chỉnh sửa nếu muốn)
log_level = logging.DEBUG # Có thể đổi thành logging.INFO cho production
logging.basicConfig(level=log_level, filename='calendar_sync.log', format='%(asctime)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s', encoding='utf-8')
# logger = logging.getLogger(__name__) # Đã khởi tạo ở trên
logger.info("Flask application starting (Ready for Prod - Batch Optimized, Indent Fixed)...")

AVAILABLE_EVENT_COLORS = ["1", "2", "3", "4", "5", "6", "7", "9", "10", "11"]
SCOPES = ['https://www.googleapis.com/auth/calendar']
TIMETABLE_TABLE_ID = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_tblThoiKhoaBieu"
DATE_SPAN_ID = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_lblDate"
# -----------------------------------------

# --- Các Hàm Trợ Giúp ---

def build_service_from_token(access_token):
    """Tạo service Google Calendar từ access token."""
    if not access_token:
        logger.error("build_service empty token.")
        return None
    try:
        creds = Credentials(token=access_token)
        if not creds or not creds.token:
            logger.error("Invalid token struct.")
            return None
        # cache_discovery=False có thể hữu ích để tránh lỗi cache cũ
        service = build('calendar', 'v3', credentials=creds, cache_discovery=False)
        logger.info("Service built from token OK.")
        return service
    except Exception as e:
        logger.exception(f"Build service error: {e}")
        return None

def extract_schedule_from_html(timetable_html, date_range_text):
    """Trích xuất lịch học (Đã sửa lỗi parse Tiết, thời gian)."""
    logger.info("Starting schedule extraction (Flexible Parsing).")
    schedule_list = []
    seen_events = set()
    date_match = re.search(r'Từ ngày\s*(\d{2}/\d{2}/\d{4})\s*đến ngày\s*(\d{2}/\d{2}/\d{4})', date_range_text, re.IGNORECASE)
    if not date_match:
        logger.error(f"Date range format error: '{date_range_text}'")
        # Thay vì raise Exception, có thể trả về lỗi để API xử lý
        return {"error": f"Date range format error: '{date_range_text}'"}, None, None
        # raise ValueError(f"Date range format error: '{date_range_text}'") # Giữ lại nếu muốn dừng hẳn
    start_date_str, end_date_str = date_match.group(1), date_match.group(2)
    try:
        # Nên đặt timezone cụ thể để tránh nhầm lẫn
        start_date_obj = datetime.strptime(start_date_str, "%d/%m/%Y").replace(tzinfo=timezone(timedelta(hours=7))) # Giả định giờ VN UTC+7
    except ValueError:
        logger.error(f"Invalid start date: '{start_date_str}'")
        return {"error": f"Invalid start date: '{start_date_str}'"}, None, None
        # raise ValueError(f"Invalid start date: '{start_date_str}'")
    logger.info(f"Parsed week: {start_date_str} - {end_date_str}")
    try:
        soup = BeautifulSoup(timetable_html, 'lxml')
    except ImportError:
        soup = BeautifulSoup(timetable_html, 'html.parser')
    tkb_table = soup.find('table', id=TIMETABLE_TABLE_ID)
    if not tkb_table:
        logger.error(f"Table not found (ID: {TIMETABLE_TABLE_ID}).")
        return {"error": f"Table not found (ID: {TIMETABLE_TABLE_ID})."}, start_date_str, end_date_str
        # raise ValueError(f"Table not found (ID: {TIMETABLE_TABLE_ID}).")
    rows = tkb_table.find_all('tr')
    if len(rows) < 2:
        logger.info("Table has less than 2 rows, no schedule data.")
        return [], start_date_str, end_date_str
    header_row = rows[0]
    header_cells = header_row.find_all(['td', 'th'])
    day_headers = [c.get_text(strip=True) for c in header_cells]
    logger.debug(f"Headers: {day_headers}")
    try:
        room_header_index = -1
        day_indices = {}
        days_list_keys = ["THỨ 2", "THỨ 3", "THỨ 4", "THỨ 5", "THỨ 6", "THỨ 7", "CHỦ NHẬT"]
        for idx, h in enumerate(day_headers):
            norm_h = h.upper().strip()
            if norm_h == "PHÒNG":
                room_header_index = idx
            elif norm_h in days_list_keys:
                day_indices[norm_h] = idx
        if room_header_index == -1:
            raise ValueError("Missing 'PHÒNG' header")
        if not day_indices:
            raise ValueError("Missing day headers")
        logger.info(f"Header: RoomIdx={room_header_index}, DayIndices={day_indices}")
    except ValueError as e:
        logger.error(f"Header structure error: {e}")
        return {"error": f"Header structure error: {e}"}, start_date_str, end_date_str
        # raise ValueError(f"Header structure error: {e}")

    for row_idx, row in enumerate(rows[1:], 1):
        cells = row.find_all('td')
        if len(cells) <= room_header_index:
            continue
        room = cells[room_header_index].get_text(strip=True) or "N/A"
        # Bỏ qua nếu phòng trống hoặc chỉ chứa khoảng trắng không hiển thị
        if not room or room.replace('\xa0', '').strip() == "" or room == "N/A":
            continue
        logger.debug(f"Row {row_idx+1}: Room='{room}'")
        for day_name_key, cell_index in day_indices.items():
            if cell_index >= len(cells):
                continue
            cell = cells[cell_index]
            # Tách các khối lịch học bằng thẻ <hr>
            cell_content_html = cell.decode_contents()
            schedule_blocks_html = re.split(r'<hr\s*/?>', cell_content_html, flags=re.IGNORECASE)

            for block_idx, block_html in enumerate(schedule_blocks_html):
                block_html_stripped = block_html.strip()
                if not block_html_stripped:
                    continue
                try:
                    # Dùng lxml nếu có, fallback về html.parser
                    try: block_soup = BeautifulSoup(block_html_stripped, 'lxml')
                    except Exception: block_soup = BeautifulSoup(block_html_stripped, 'html.parser')

                    # Lấy text và làm sạch
                    block_text_lines_raw = list(block_soup.stripped_strings)
                    block_text_lines = [ln.strip().strip('"').strip() for ln in block_text_lines_raw if ln.strip()]
                    logger.debug(f"Cell({row_idx+1},{cell_index}), Block {block_idx+1}: Lines={block_text_lines}")
                    if not block_text_lines: continue

                    # Khởi tạo các biến
                    subject = ""; time_range = ""; periods = ""; teacher = ""; location = ""
                    time_match = None; periods_found = False

                    if block_text_lines: subject = block_text_lines[0] # Dòng đầu tiên thường là môn học

                    # Duyệt các dòng còn lại để tìm thông tin
                    for line in block_text_lines[1:]:
                        cleaned_line = line
                        # Tìm thời gian (linh hoạt hơn với h hoặc :)
                        t_match = re.search(r'(\d{1,2}[h:]\d{2})\s*(?:->|-|đến)\s*(\d{1,2}[h:]\d{2})|(\d{1,2}[h:]\d{2})', cleaned_line)
                        if t_match and not time_match: # Chỉ lấy kết quả khớp đầu tiên
                            time_range = cleaned_line
                            time_match = t_match
                            logger.debug(f"Time match: Raw='{cleaned_line}' Groups={time_match.groups()}")

                        # Tìm tiết học (không phân biệt hoa thường)
                        p_match = re.search(r'Tiết\s*([\d\-\.]+)', cleaned_line, re.IGNORECASE)
                        if p_match:
                            periods = p_match.group(1).strip()
                            logger.debug(f"Periods regex: '{periods}'")
                            periods_found = True

                        # Tìm giáo viên và cơ sở
                        elif cleaned_line.lower().startswith('gv'):
                            teacher = cleaned_line[3:].strip().lstrip(':').strip()
                        elif cleaned_line.lower().startswith('cơ sở'):
                            location = cleaned_line[6:].strip().lstrip(':').strip()

                    if not periods_found: logger.warning(f"No 'Tiết:' info for '{subject}': {block_text_lines}")
                    if not time_match: logger.warning(f"No time found for '{subject}'. Skip."); continue # Bỏ qua nếu không có giờ

                    if subject:
                        try:
                            # Xác định ngày dựa vào thứ và ngày bắt đầu tuần
                            day_index = days_list_keys.index(day_name_key)
                            current_date = start_date_obj + timedelta(days=day_index)
                            current_date_str = current_date.strftime("%d/%m/%Y") # Dùng để tạo datetime object

                            # Xử lý thời gian bắt đầu/kết thúc
                            start_str = ""; end_str = ""
                            g1, g2, g3 = time_match.group(1), time_match.group(2), time_match.group(3)

                            if g1 and g2: # Có cả giờ bắt đầu và kết thúc (vd: 7h30 -> 9h30)
                                start_str = g1; end_str = g2
                            elif g3: # Chỉ có giờ bắt đầu (vd: 13:00)
                                start_str = g3
                            else:
                                logger.warning(f"Time parse failed for '{subject}'. Skip.")
                                continue

                            # Xác định định dạng giờ (HhM hay H:M)
                            start_format = "%Hh%M" if 'h' in start_str else "%H:%M"
                            start_dt_naive = datetime.strptime(f"{current_date_str} {start_str}", f"%d/%m/%Y {start_format}")
                            # Gán timezone VN (UTC+7)
                            start_dt = timezone(timedelta(hours=7)).localize(start_dt_naive)

                            end_dt = start_dt # Mặc định giờ kết thúc bằng giờ bắt đầu
                            if end_str:
                                end_format = "%Hh%M" if 'h' in end_str else "%H:%M"
                                end_dt_naive = datetime.strptime(f"{current_date_str} {end_str}", f"%d/%m/%Y {end_format}")
                                end_dt = timezone(timedelta(hours=7)).localize(end_dt_naive)

                                # Xử lý trường hợp giờ kết thúc nhỏ hơn hoặc bằng giờ bắt đầu (có thể do lỗi nhập liệu)
                                if end_dt <= start_dt:
                                    logger.warning(f"'{subject}': End time <= Start time. Setting end = start + 45 mins (estimated). Original end: {end_str}")
                                    # Hoặc có thể đặt end_dt = start_dt, hoặc thêm 1 khoảng thời gian ước tính
                                    end_dt = start_dt + timedelta(minutes=45) # Ước tính 1 tiết?

                            # Chuyển sang định dạng ISO 8601 mà Google Calendar yêu cầu
                            start_iso = start_dt.isoformat()
                            end_iso = end_dt.isoformat()

                            logger.debug(f"Final DateTime: Start={start_iso}, End={end_iso}")

                            # Tạo key để kiểm tra trùng lặp trong cùng 1 lần scrape
                            event_key = (subject, start_iso, end_iso, room)
                            if event_key in seen_events:
                                logger.warning(f"Skipping duplicate event found during scrape: {event_key}")
                                continue
                            seen_events.add(event_key)

                            # Mô tả thêm (nếu chỉ có giờ bắt đầu)
                            desc_extra = "\n(Chỉ có giờ bắt đầu)" if start_dt == end_dt and not end_str else ""

                            schedule_list.append({
                                "date": current_date_str, # Giữ lại để tham khảo nếu cần
                                "day_name": day_name_key,
                                "room": room,
                                "subject": subject,
                                "time_range": time_range, # Giữ lại giờ gốc dạng text
                                "periods": periods,
                                "teacher": teacher,
                                "location": location, # Cơ sở
                                "start_datetime": start_iso, # ISO Format
                                "end_datetime": end_iso,   # ISO Format
                                "description_extra": desc_extra
                            })
                            logger.debug(f"Prepared Event: Subject='{subject}', Periods='{periods}', Start='{start_iso}'")

                        except ValueError as e:
                            logger.error(f"Error parsing date/time/day for '{subject}': {e}. Lines: {block_text_lines}")
                        except Exception as e:
                            logger.exception(f"Unexpected error processing block for '{subject}': {e}")

                except Exception as block_parse_error:
                     logger.exception(f"Error parsing HTML block in Cell({row_idx+1},{cell_index}): {block_parse_error}")


    logger.info(f"Extraction finished. Found {len(schedule_list)} potential events.")
    # Ghi log chi tiết danh sách sự kiện đã trích xuất (nếu cần debug)
    # logger.debug("--- Final Extracted Schedule List (Before Google Sync) ---\n%s\n--- End List ---", pprint.pformat(schedule_list))
    return schedule_list, start_date_str, end_date_str

# ----- Các Flask Routes -----

@app.route('/')
def index():
    # Trả về HTML đơn giản để biết backend đang chạy
    return """<html><head><title>UEL Sync Backend</title></head><body><h1>UEL Sync Backend OK</h1><p>Backend is running. Use the Chrome Extension to sync.</p></body></html>"""

# Biến toàn cục để lưu kết quả batch (Reset mỗi lần gọi API)
batch_results = {'added': 0, 'errors': 0}

# Hàm callback cho Batch Request
def handle_batch_response(request_id, response, exception):
    """Xử lý kết quả trả về cho từng request trong batch."""
    global batch_results # Sử dụng biến toàn cục
    if exception is not None:
        # Lỗi xảy ra với request này
        error_details = "Unknown batch item error"
        if isinstance(exception, HttpError):
            try:
                # Cố gắng lấy thông điệp lỗi cụ thể từ Google
                error_content = json.loads(exception.content.decode('utf-8'))
                error_details = error_content.get('error', {}).get('message', exception.content.decode('utf-8'))
            except:
                 # Nếu không parse được JSON lỗi, dùng nội dung gốc hoặc exception string
                 error_details = exception.content.decode('utf-8') if exception.content else str(exception)
            logger.error(f"Batch request item {request_id} failed (HttpError {exception.resp.status}): {error_details}")
        else:
             # Các loại lỗi khác (vd: network error)
             error_details = str(exception)
             logger.error(f"Batch request item {request_id} failed (Non-HttpError): {error_details}")
        batch_results['errors'] += 1
    else:
        # Request thành công
        logger.info(f"Batch request item {request_id} succeeded. Event ID: {response.get('id')}")
        batch_results['added'] += 1


@app.route('/sync_from_extension', methods=['POST'])
def sync_from_extension():
    """Endpoint đồng bộ chính - Tối ưu Batch + Check In-Memory, Màu theo môn học."""
    start_time_process = time.time()
    # Reset kết quả batch cho mỗi lần gọi API mới
    global batch_results
    batch_results = {'added': 0, 'errors': 0}
    logger.info("Received request on /sync_from_extension (Batch Optimized, Color by Subject)")

    # 1. Lấy Token và Dữ liệu từ Extension
    auth_header = request.headers.get('Authorization')
    access_token = None
    if auth_header and auth_header.startswith('Bearer '):
        access_token = auth_header.split(' ')[1]

    if not access_token:
        logger.warning("Authorization header missing or invalid.")
        return jsonify({"error": "Access Token missing or invalid format."}), 401

    if not request.is_json:
        logger.warning("Request content type is not JSON.")
        return jsonify({"error": "Request must be JSON."}), 415

    data = request.json
    if not data:
        logger.warning("No JSON data received in request.")
        return jsonify({"error": "No JSON data received."}), 400

    user_id = data.get('user_id') # Lấy user_id nếu có (có thể không cần thiết cho logic chính)
    timetable_html = data.get('timetable_html')
    date_range_text = data.get('date_range_text')

    logger.debug(f"Sync Data Received: user='{user_id}', date_range='{date_range_text}', html_present={'Yes' if timetable_html else 'No'}")

    # Kiểm tra dữ liệu đầu vào cần thiết
    missing_data = None
    if not timetable_html: missing_data = "timetable_html"
    elif not date_range_text: missing_data = "date_range_text"
    # user_id có thể không bắt buộc cho logic chính, tùy yêu cầu

    if missing_data:
        logger.error(f"Missing required data in request: {missing_data}")
        return jsonify({"error": f"Missing required data: {missing_data}"}), 400

    logger.info(f"Processing sync request for user: {user_id or 'Unknown'}")

    # 2. Tạo Google Calendar Service
    try:
        service = build_service_from_token(access_token)
        if not service: # build_service_from_token trả về None nếu token không hợp lệ
             logger.error("Failed to build Google Calendar service, likely invalid token.")
             return jsonify({"error": "Invalid or expired Google token."}), 401
    except Exception as e:
        # Lỗi không mong muốn khi tạo service (hiếm gặp)
        logger.exception(f"Unexpected error building Google Calendar service: {e}")
        return jsonify({"error": "Server error connecting to Google services."}), 500

    # 3. Trích xuất sự kiện từ HTML
    try:
        # Gọi hàm trích xuất
        extracted_result, week_start, week_end = extract_schedule_from_html(timetable_html, date_range_text)

        # Kiểm tra xem hàm extract có trả về lỗi không
        if isinstance(extracted_result, dict) and 'error' in extracted_result:
             logger.error(f"HTML Extraction failed: {extracted_result['error']}")
             return jsonify({"error": f"Timetable parsing error: {extracted_result['error']}"}), 400

        # Nếu không lỗi, extracted_result là schedule_list
        schedule_list = extracted_result
        logger.info(f"Successfully extracted {len(schedule_list)} events for week {week_start} - {week_end}")

    except Exception as e:
        # Bắt các lỗi không mong muốn khác từ hàm extract
        logger.exception(f"Unexpected error during HTML extraction: {e}")
        return jsonify({"error": "Server error during timetable extraction."}), 500

    # 4. Nếu không có sự kiện nào được trích xuất, trả về ngay
    if not schedule_list:
        proc_time = time.time() - start_time_process
        logger.info(f"No events extracted for week {week_start}-{week_end}. Sync finished.")
        return jsonify({
            "message": f"No events found or extracted for the week {week_start} - {week_end}.",
            "week": f"{week_start}-{week_end}",
            "added": 0, "skipped": 0, "errors": 0,
            "processing_time": round(proc_time, 2)
        })

    # 5. Lấy các sự kiện đã có trên Google Calendar cho tuần này để so sánh
    existing_events_set = set() # Dùng set để kiểm tra tồn tại nhanh O(1)
    try:
        # Xác định khoảng thời gian truy vấn (cần chuyển sang UTC và ISO format)
        start_dt_obj_naive = datetime.strptime(week_start, "%d/%m/%Y")
        # Giả định tuần TKB bắt đầu từ 00:00 ngày đầu tiên theo giờ VN
        start_dt_obj = timezone(timedelta(hours=7)).localize(start_dt_obj_naive)

        end_dt_obj_naive = datetime.strptime(week_end, "%d/%m/%Y")
         # Giả định tuần TKB kết thúc vào 23:59:59 ngày cuối cùng theo giờ VN
        end_dt_obj = timezone(timedelta(hours=7)).localize(end_dt_obj_naive.replace(hour=23, minute=59, second=59))

        # Chuyển sang UTC và định dạng ISO Z cho query API
        time_min_query = start_dt_obj.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
        time_max_query = end_dt_obj.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')

        logger.info(f"Fetching existing Google Calendar events from {time_min_query} to {time_max_query}")

        page_token = None
        items_fetched_count = 0
        while True: # Lặp để lấy tất cả các trang kết quả
            events_result = service.events().list(
                calendarId='primary', # Lấy từ lịch chính
                timeMin=time_min_query,
                timeMax=time_max_query,
                singleEvents=True, # Tách các sự kiện lặp lại thành sự kiện đơn lẻ
                maxResults=250, # Số lượng tối đa mỗi trang (max 2500, nhưng 250 là đủ thường)
                pageToken=page_token # Token để lấy trang tiếp theo
            ).execute()

            items = events_result.get('items', [])
            items_fetched_count += len(items)

            # Tạo key cho mỗi sự kiện hiện có để so sánh
            for item in items:
                 summary = item.get('summary')
                 start_iso_gcal = item.get('start', {}).get('dateTime') # Lấy đúng dateTime
                 end_iso_gcal = item.get('end', {}).get('dateTime')
                 loc_gcal = item.get('location', '').strip() # Lấy location, làm sạch khoảng trắng

                 # Chỉ thêm vào set nếu có đủ thông tin cơ bản để so sánh
                 if all([summary, start_iso_gcal, end_iso_gcal]):
                     # Key bao gồm: Tên sự kiện, thời gian bắt đầu ISO, thời gian kết thúc ISO, địa điểm
                     existing_events_set.add((summary, start_iso_gcal, end_iso_gcal, loc_gcal))

            page_token = events_result.get('nextPageToken')
            if not page_token: # Không còn trang nào nữa
                break
        logger.info(f"Found {len(existing_events_set)} existing event details in Google Calendar for the target week.")

    except HttpError as e:
        # Lỗi khi gọi API list() của Google
        logger.error(f"Google API Error fetching existing events: {e.resp.status} - {e.content.decode()}")
        # Trả về lỗi cho client biết không thể kiểm tra sự kiện hiện có
        return jsonify({"error": "Error checking existing events on Google Calendar. Please try again later."}), 503 # Service Unavailable
    except Exception as e:
        # Lỗi không mong muốn khác
        logger.exception(f"Unexpected error fetching existing Google events: {e}")
        return jsonify({"error": "Server error while checking existing events."}), 500

    # 6. Chuẩn bị Batch Request và xử lý sự kiện
    batch = service.new_batch_http_request(callback=handle_batch_response)
    events_to_insert_count = 0
    skipped_count = 0

    # Logic gán màu theo môn học
    subject_color_map = {}
    next_color_index = 0
    num_colors = len(AVAILABLE_EVENT_COLORS)

    logger.info(f"Processing {len(schedule_list)} extracted events against {len(existing_events_set)} existing Google events...")

    # Duyệt qua danh sách sự kiện đã trích xuất từ HTML
    for i, event_data in enumerate(schedule_list, 1):
        # Lấy thông tin cần thiết để tạo key so sánh và tạo sự kiện
        subject_name = event_data.get('subject', 'Unknown Subject')
        start_iso = event_data['start_datetime'] # Đã ở định dạng ISO UTC+7
        end_iso = event_data['end_datetime']     # Đã ở định dạng ISO UTC+7
        room = event_data.get('room', 'N/A')
        location_norm = room.strip() # Địa điểm dùng để so sánh là phòng học đã strip()

        # Tạo key cho sự kiện vừa trích xuất
        event_key_extracted = (subject_name, start_iso, end_iso, location_norm)

        # *** KIỂM TRA SỰ TỒN TẠI ***
        if event_key_extracted not in existing_events_set:
            # Nếu sự kiện CHƯA tồn tại trong Google Calendar -> Thêm vào batch
            events_to_insert_count += 1

            # Gán màu
            if subject_name in subject_color_map:
                color_id = subject_color_map[subject_name]
            else:
                # Gán màu mới và lưu lại mapping
                color_id = AVAILABLE_EVENT_COLORS[next_color_index % num_colors]
                subject_color_map[subject_name] = color_id
                logger.info(f"Assigning new color {color_id} to subject: '{subject_name}' (Index {next_color_index})")
                next_color_index += 1

            logger.debug(f"Event {i} ('{subject_name}' - Color: {color_id}) marked for BATCH INSERT.")

            # Tạo nội dung chi tiết cho sự kiện
            periods_text = f"\nTiết: {event_data.get('periods')}" if event_data.get('periods') else ""
            teacher_text = f"GV: {event_data.get('teacher', 'N/A')}"
            location_text = f"CS: {event_data.get('location', 'N/A')}" # Cơ sở
            room_text = f"Phòng: {room}"
            desc_extra = event_data.get('description_extra', '') # Ghi chú thêm (vd: chỉ có giờ bắt đầu)
            description = f"{teacher_text}\n{location_text}{periods_text}\n{room_text}{desc_extra}"

            # Tạo body cho API request (tuân thủ cấu trúc của Google Calendar API)
            event_body = {
                'summary': subject_name,
                'location': room, # Location hiển thị trên Google Calendar là phòng học
                'description': description,
                'start': {
                    'dateTime': start_iso, # ISO format đã có timezone
                    'timeZone': 'Asia/Ho_Chi_Minh' # Vẫn nên chỉ định rõ timezone
                },
                'end': {
                    'dateTime': end_iso,   # ISO format đã có timezone
                    'timeZone': 'Asia/Ho_Chi_Minh'
                },
                'colorId': color_id, # Gán màu đã chọn
                'reminders': { # Thêm nhắc nhở mặc định 15 phút trước khi sự kiện bắt đầu
                    'useDefault': False,
                    'overrides': [
                        {'method': 'popup', 'minutes': 15},
                    ],
                },
                # Có thể thêm các trường khác nếu muốn: attendees, source, transparency...
            }

            # Thêm request tạo sự kiện này vào batch
            # request_id giúp định danh trong callback handle_batch_response
            request_id_str = f"event-{i}-{subject_name[:15].replace(' ', '_')}" # Tạo ID dễ nhận biết
            batch.add(
                service.events().insert(calendarId='primary', body=event_body),
                request_id=request_id_str
            )

        else:
            # Nếu sự kiện ĐÃ tồn tại -> Bỏ qua
            logger.info(f"Skipping event {i} (already exists in Google Calendar based on key): '{subject_name}' Start: {start_iso}")
            skipped_count += 1

    # 7. Thực thi Batch Request nếu có sự kiện cần thêm
    added_count = 0
    error_count = 0
    if events_to_insert_count > 0:
        logger.info(f"Executing batch request to insert {events_to_insert_count} new events...")
        try:
            # Gửi toàn bộ batch request đến Google API
            batch.execute()
            # Kết quả thực tế được cập nhật trong biến toàn cục batch_results thông qua callback
            added_count = batch_results['added']
            error_count = batch_results['errors']
            logger.info(f"Batch execution finished. Callback results: Added={added_count}, Errors={error_count}")
            # Nếu số lỗi trả về từ callback < số lượng dự định thêm, thì có thể một số lỗi không được callback xử lý (hiếm)
            if error_count < (events_to_insert_count - added_count):
                 logger.warning(f"Potential discrepancy in batch results. Expected inserts: {events_to_insert_count}, Callback Added: {added_count}, Callback Errors: {error_count}")

        except HttpError as e:
            # Lỗi nghiêm trọng khi thực thi cả batch (vd: vấn đề xác thực chung, lỗi server Google)
            logger.error(f"Batch execution failed entirely (HttpError): {e.resp.status} - {e.content.decode()}")
            # Giả định tất cả các sự kiện trong batch đều lỗi trong trường hợp này
            error_count = events_to_insert_count
            added_count = 0 # Không có gì được thêm
        except Exception as e:
            # Lỗi không mong muốn khác khi thực thi batch
            logger.exception(f"Batch execution failed entirely (Unexpected Error): {e}")
            error_count = events_to_insert_count # Giả định tất cả lỗi
            added_count = 0
    else:
        # Không có sự kiện mới nào cần thêm
        logger.info("No new events to insert via batch request.")

    # 8. Trả kết quả cuối cùng về cho Extension
    proc_time = time.time() - start_time_process
    summary_msg = f"Sync finished for week {week_start}-{week_end}: User={user_id or 'Unknown'}, Added={added_count}, Skipped={skipped_count}, Errors={error_count}, Time={proc_time:.2f}s"
    logger.info(summary_msg)

    # Tạo thông điệp phản hồi
    response_message = f"Sync complete for week {week_start} - {week_end}."
    if added_count > 0: response_message += f" Added {added_count} event(s)."
    if skipped_count > 0: response_message += f" Skipped {skipped_count} existing event(s)."
    if error_count > 0: response_message += f" Encountered {error_count} error(s) during sync."

    return jsonify({
        "message": response_message,
        "week": f"{week_start}-{week_end}",
        "added": added_count,
        "skipped": skipped_count,
        "errors": error_count,
        "processing_time": round(proc_time, 2)
    })


# --- Khối chạy chính ---
if __name__ == "__main__":
    # In thông tin khi chạy trực tiếp file (dùng cho local dev hoặc khi chạy bằng python app.py)
    print("-" * 60)
    print(" Starting Flask Server - UEL Calendar Sync Backend (Production Ready) ")
    print("-" * 60)
    # Lấy port từ biến môi trường PORT (thường do Render/Heroku cung cấp) hoặc dùng 5001 mặc định
    port = int(os.environ.get('PORT', 5001))
    # Khi deploy, Gunicorn sẽ được dùng để chạy app, dòng app.run() này thường không được thực thi
    # Nhưng vẫn để lại để có thể chạy local nếu cần
    # **KHÔNG dùng debug=True ở đây nữa**
    app.run(host="0.0.0.0", port=port)
