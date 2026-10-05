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
found = False
try:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.2)[0]:
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                break
        if 'Задания:'.encode() in output:
            found = True
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
if not found:
    sys.exit('TUI indicator did not render; inspect isolated tui-screen.txt')
sys.stdout.write('PASS TUI indicator rendered in real terminal\n')
