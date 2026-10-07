import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
environment = dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor')
process = subprocess.Popen([sys.argv[1], '--session', sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env=environment)
os.close(slave)
output = bytearray()
phase = bytearray()
stage = 0

def send(value):
    os.write(master, value)

try:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.2)[0]:
            try:
                chunk = os.read(master, 65536)
                output.extend(chunk)
                phase.extend(chunk)
            except OSError:
                break
        if stage == 0 and 'Задания:'.encode() in phase:
            send(b'/joblist')
            phase.clear()
            stage = 1
        elif stage == 1 and 'Задания и мониторы'.encode() in phase:
            send(b'\r')
            phase.clear()
            stage = 2
        elif stage == 2 and b'tui-child.cjs' in phase:
            send(b'\r')
            phase.clear()
            stage = 3
        elif stage == 3 and b'NATIVE_TUI_OUTPUT' in phase:
            send(b'\x18')
            phase.clear()
            stage = 4
        elif stage == 4 and 'Задание отменено.'.encode() in phase:
            stage = 5
            break
        if process.poll() is not None:
            break
finally:
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    os.close(master)
    with open(sys.argv[3], 'wb') as result:
        result.write(output)
if stage != 5:
    sys.exit(f'TUI task management stopped at stage {stage}; inspect isolated tui-screen.txt')
sys.stdout.write('PASS real TUI: footer, local command, selected output, cancellation\n')
