#!/bin/sh
# Vòng lặp dashboard: bật Wi-Fi → tải PNG → hiển thị bằng eips → tắt Wi-Fi → ngủ (RTC) → lặp lại.
# Được chạy nền bởi documents/Dashboard.sh. Thoát: bấm nút nguồn 1 lần (dự phòng: giữ ~40 giây để khởi động lại).
# Cách tắt giao diện, đánh thức bằng RTC dựa theo usetrmnl/trmnl-kindle (MIT).

DIR="${DASH_DIR:-/mnt/us/dashboard}"
LOG="$DIR/log.txt"
IMG="/tmp/dashboard.png"
. "$DIR/config.sh"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
  # giữ log nhỏ
  if [ "$(wc -c < "$LOG")" -gt 200000 ]; then tail -n 300 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
}

wifi() { lipc-set-prop com.lab126.cmd wirelessEnable "$1" 2>/dev/null; }

# 1 = đang cắm cáp/sạc, 0 = chạy pin (dùng để phân biệt cắm/rút cáp với bấm nút nguồn)
charging() {
  c=$(lipc-get-prop com.lab126.powerd isCharging 2>/dev/null)
  [ -n "$c" ] || c=$(cat /sys/class/power_supply/*/online 2>/dev/null | head -1)
  echo "${c:-?}"
}

battery() {
  b=$(lipc-get-prop com.lab126.powerd battLevel 2>/dev/null)
  [ -n "$b" ] || b=$(lipc-get-prop com.lab126.powerd status 2>/dev/null | grep "Battery Level:" | cut -d: -f2 | tr -d '% ')
  echo "${b:-100}"
}

# Ghi trạng thái giao diện + powerd vào log (để dò lỗi màn hình Kindle tự hiện lại)
diag() {
  g=$(status lab126_gui 2>&1 | head -1); f=$(status framework 2>&1 | head -1)
  p=$(lipc-get-prop com.lab126.powerd state 2>&1); s=$(lipc-get-prop com.lab126.powerd preventScreenSaver 2>&1)
  log "  [$1] gui: ${g:-?} | framework: ${f:-?} | powerd: ${p:-?} | chặn chờ: ${s:-?}"
}

stop_gui() {
  # Tắt giao diện Kindle để icon trạng thái không vẽ đè lên ảnh và cho phép ngủ sâu.
  if /etc/init.d/framework stop >/dev/null 2>&1; then
    log "  dừng giao diện: init.d/framework"
  else
    stop framework >/dev/null 2>&1 || initctl stop framework >/dev/null 2>&1
    stop lab126_gui >/dev/null 2>&1
    log "  dừng giao diện: stop framework/lab126_gui"
  fi
  initctl stop webreader >/dev/null 2>&1
  lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null
}

init() {
  log "=== Khởi động dashboard ==="
  diag "trước khi tắt"
  stop_gui
  { echo powersave > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor; } 2>/dev/null
  diag "sau khi tắt"
}

# Giao diện Kindle tự bật lại (vẽ màn hình khoá đè lên dashboard)? → tắt lại
recheck_gui() {
  if status lab126_gui 2>/dev/null | grep -q running || status framework 2>/dev/null | grep -q running; then
    log "  Giao diện Kindle đã tự bật lại → tắt lại"
    diag "phát hiện giao diện"
    stop_gui
  fi
}

wait_net() {
  # chờ tối đa 45 giây đến khi có Internet
  i=0
  while [ $i -lt 45 ]; do
    curl -s -m 5 -o /dev/null -I "$IMAGE_URL" && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

fetch_and_show() {
  wifi 1
  if ! wait_net; then
    log "Không có mạng"
    wifi 0; sleep 15; wifi 1          # thử bật lại Wi-Fi một lần
    wait_net || { eips 1 1 "Khong co Wi-Fi - se thu lai sau"; return 1; }
  fi
  rm -f "$IMG"
  # thêm ?t=... để không bị bộ nhớ đệm CDN trả ảnh cũ
  # Có ALT_IMAGE_URL thì luân phiên: lần này ảnh chính, lần sau ảnh phụ, rồi lặp lại
  URL="$IMAGE_URL"
  if [ -n "$ALT_IMAGE_URL" ]; then
    n=$(cat /tmp/dashboard_turn 2>/dev/null || echo 0)
    [ $((n % 2)) -eq 1 ] && URL="$ALT_IMAGE_URL"
    echo $((n + 1)) > /tmp/dashboard_turn
  fi
  curl -s -L -m 60 -o "$IMG" "$URL?t=$(date +%s)"
  if [ ! -s "$IMG" ]; then
    log "Tải ảnh thất bại"
    eips 1 1 "Tai anh that bai - se thu lai sau"
    return 1
  fi
  eips -c
  sleep 1
  eips -g "$IMG"
  b=$(battery)
  if [ "$b" -lt "${LOW_BATTERY:-15}" ] 2>/dev/null; then
    eips 1 1 "PIN YEU ${b}% - HAY SAC"
  fi
  log "Đã cập nhật (pin ${b}%)"
  return 0
}

sleep_secs() {
  mins=${INTERVAL_MIN:-30}
  [ "$mins" -ge 5 ] 2>/dev/null || mins=5
  h=$(date +%H | sed 's/^0//'); h=${h:-0}
  ns=${NIGHT_START:-23}; ne=${NIGHT_END:-6}
  if [ "$ns" != "$ne" ]; then
    night=0
    if [ "$ns" -gt "$ne" ]; then { [ "$h" -ge "$ns" ] || [ "$h" -lt "$ne" ]; } && night=1
    else { [ "$h" -ge "$ns" ] && [ "$h" -lt "$ne" ]; } && night=1; fi
    if [ $night -eq 1 ]; then
      # ngủ tới giờ NIGHT_END (tính theo giờ tròn)
      left=$(( (ne - h + 24) % 24 ))
      [ $left -eq 0 ] && left=24
      until_end=$(( left * 3600 - $(date +%M | sed 's/^0//;s/^$/0/') * 60 ))
      # NIGHT_INTERVAL_MIN > 0: ban đêm vẫn dậy làm mới mỗi N phút (không quá giờ NIGHT_END)
      nim=${NIGHT_INTERVAL_MIN:-0}
      if [ "$nim" -ge 5 ] 2>/dev/null && [ $(( nim * 60 )) -lt $until_end ]; then
        echo $(( nim * 60 ))
      else
        echo $until_end
      fi
      return
    fi
  fi
  echo $(( mins * 60 ))
}

go_to_sleep() {
  secs=$1
  [ "${WIFI_OFF_WHILE_SLEEP:-1}" = 1 ] && wifi 0
  log "Ngủ ${secs}s"
  sleep 10   # chờ màn hình vẽ xong; cũng là khoảng để dừng script nếu cần
  [ -n "$DASH_ONCE" ] && exit 0
  RTC=/sys/class/rtc/rtc1
  [ -d "$RTC" ] || RTC=/sys/class/rtc/rtc0
  wake_at=$(( $(date +%s) + secs ))
  c0=$(charging)
  # đặt báo thức RTC rồi ngủ sâu; nếu không được thì sleep thường
  if { echo 0 > "$RTC/wakealarm" &&
       echo "+${secs}" > "$RTC/wakealarm" &&
       echo mem > /sys/power/state; } 2>/dev/null; then
    sleep 2   # chờ Kindle cập nhật trạng thái sạc sau khi cắm/rút cáp
    left=$(( wake_at - $(date +%s) ))
    c1=$(charging)
    log "Thức dậy (ngủ sâu, sớm hơn hẹn ${left}s, sạc: $c0→$c1)"
    diag "sau khi thức"
    # Tỉnh dậy sớm hơn giờ hẹn quá 60 giây:
    #  - trạng thái sạc vừa đổi = cắm/rút cáp → không thoát, ngủ tiếp cho hết giờ
    #  - còn lại = có người bấm nút nguồn → thoát dashboard
    if [ "$left" -gt 60 ]; then
      if [ "$c0" != "$c1" ]; then
        log "Cắm/rút cáp → ngủ tiếp"
        go_to_sleep "$left"
      else
        exit_dashboard
      fi
    fi
  else
    log "Không ngủ sâu được → chờ thường ${secs}s"
    diag "trước khi chờ thường"
    sleep "$secs"
    log "Hết giờ chờ thường"
  fi
}

exit_dashboard() {
  log "Bấm nút nguồn → thoát dashboard, bật lại giao diện Kindle"
  echo 0 > "$RTC/wakealarm" 2>/dev/null
  eips -c
  eips 1 1 "Dang thoat dashboard, cho chut..."
  lipc-set-prop com.lab126.powerd preventScreenSaver 0 2>/dev/null
  wifi 1
  /etc/init.d/framework start 2>/dev/null || {
    start lab126_gui >/dev/null 2>&1
    start framework >/dev/null 2>&1 || initctl start framework >/dev/null 2>&1
  }
  exit 0
}

init
while true; do
  recheck_gui
  if fetch_and_show; then
    go_to_sleep "$(sleep_secs)"
  else
    go_to_sleep 300   # lỗi thì 5 phút sau thử lại
  fi
done
