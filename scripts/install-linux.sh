#!/bin/sh
set -eu
umask 077
artifact=${1:-.runtime/package}
target="$HOME/.config/opencode/plugins/jobs"
state="${XDG_DATA_HOME:-$HOME/.local/share}/opencode-jobs"
unit="$HOME/.config/systemd/user/opencode-jobs.service"
node=$(command -v node)
test -f "$artifact/index.js" || { echo 'Нет проверенного артефакта' >&2; exit 1; }
test ! -e "$target" || { echo 'Каталог уже существует; нужна проверка обновления' >&2; exit 1; }
test ! -e "$unit" || { echo 'Служба уже существует' >&2; exit 1; }
mkdir -p "$state" "$HOME/.config/opencode/plugins" "$HOME/.config/systemd/user"
staging="$state/install-$$"
mkdir "$staging"
cp -R "$artifact/." "$staging/"
diff -qr "$artifact" "$staging"
mv "$staging" "$target"
cat > "$unit" <<EOF
[Unit]
Description=Local OpenCode V2 jobs scheduler
After=opencode.service

[Service]
Type=simple
ExecStart=$node $target/src/pump.js
WorkingDirectory=$target
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now opencode-jobs.service
systemctl --user is-active --quiet opencode-jobs.service
systemctl --user is-enabled --quiet opencode-jobs.service
count=0
while test "$count" -lt 30; do
  if "$node" -e 'const fs=require("node:fs");const p=process.argv[1];if(!fs.existsSync(p))process.exit(1);const s=JSON.parse(fs.readFileSync(p));process.exit(s.ok&&Date.now()-s.time<5000?0:1)' "$state/pump-status.json"; then
    echo 'Проверено: пользовательская служба jobs работает, сервер доступен'
    exit 0
  fi
  count=$((count+1))
  sleep 1
done
echo 'Служба записана, но здоровье pump не подтверждено. Не считать установку успешной' >&2
exit 1
