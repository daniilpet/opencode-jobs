#!/bin/sh
set -eu
umask 077
artifact=${1:-.runtime/package}
target="$HOME/.config/opencode/plugins/jobs"
state="${XDG_DATA_HOME:-$HOME/.local/share}/opencode-jobs"
label="com.daniilpet.opencode-jobs"
uid=$(id -u)
plist="$HOME/Library/LaunchAgents/$label.plist"
node=$(command -v node)
test -f "$artifact/index.js" || { echo 'Нет проверенного артефакта' >&2; exit 1; }
test ! -e "$target" || { echo 'Каталог уже существует; нужна проверка обновления' >&2; exit 1; }
test ! -e "$plist" || { echo 'Служба уже существует' >&2; exit 1; }
! launchctl print "gui/$uid/$label" >/dev/null 2>&1 || { echo 'Служба уже запущена' >&2; exit 1; }
mkdir -p "$state" "$HOME/.config/opencode/plugins" "$HOME/Library/LaunchAgents"
staging="$state/install-$$"
mkdir "$staging"
cp -R "$artifact/." "$staging/"
diff -qr "$artifact" "$staging"
mv "$staging" "$target"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$label</string>
	<key>ProgramArguments</key>
	<array>
		<string>$node</string>
		<string>$target/src/pump.js</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$target</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>Crashed</key>
		<true/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>UMask</key>
	<integer>63</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>$state/pump.log</string>
	<key>StandardErrorPath</key>
	<string>$state/pump.log</string>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$uid" "$plist"
launchctl enable "gui/$uid/$label"
count=0
while test "$count" -lt 30; do
  if "$node" -e 'const fs=require("node:fs");const p=process.argv[1];if(!fs.existsSync(p))process.exit(1);const s=JSON.parse(fs.readFileSync(p));process.exit(s.ok&&Date.now()-s.time<5000?0:1)' "$state/pump-status.json"; then
    echo 'Проверено: LaunchAgent jobs работает, сервер доступен'
    exit 0
  fi
  count=$((count+1))
  sleep 1
done
echo 'Служба записана, но здоровье pump не подтверждено. Не считать установку успешной' >&2
exit 1
