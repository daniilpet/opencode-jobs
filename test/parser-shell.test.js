import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, assertSafeCommand, utf8Command } from '../src/parser.js';

test('вложенный pwsh -Command с двойными кавычками и $ отклоняется до запуска', () => {
  assert.throws(() => parse('background', 'pwsh -NoProfile -Command "cd C:\\x; while ($true) { Write-Output 1 }"'), /интерполирует переменные/);
  assert.throws(() => parse('monitor', '--regex X -- pwsh -NoProfile -Command "while ($true) { Write-Output 1 }"'), /интерполирует переменные/);
});

test('регистронезависимость и экранированные кавычки не обходят защиту', () => {
  assert.throws(() => assertSafeCommand('PWSH.EXE -Command "while ($true) {}"'), /интерполирует переменные/);
  assert.throws(() => assertSafeCommand('pwsh -command "while ($true) {}"'), /интерполирует переменные/);
  assert.throws(() => assertSafeCommand('powershell.exe -Command "while ($true) {}"'), /интерполирует переменные/);
  assert.throws(() => assertSafeCommand('pwsh -Command "Write-Output \`"x\`"; while ($true) {}"'), /интерполирует переменные/);
  assert.throws(() => assertSafeCommand('cd C:\\x; pwsh -Command "while ($true) {}"'), /интерполирует переменные/);
});

test('прямая команда с $true, одинарные кавычки и обычные команды допускаются', () => {
  assert.doesNotThrow(() => parse('background', 'Write-Output $true'));
  assert.doesNotThrow(() => parse('background', 'while ($true) { Write-Output 1; break }'));
  assert.doesNotThrow(() => parse('background', "pwsh -NoProfile -Command 'while ($true) { Write-Output 1; break }'"));
  assert.doesNotThrow(() => assertSafeCommand('glab ci status --branch main'));
  assert.doesNotThrow(() => parse('monitor', '--regex X -- while ($true) { Write-Output 1; break }'));
});

test('упоминание pwsh в строках и аргументах других команд не отклоняется', () => {
  assert.doesNotThrow(() => assertSafeCommand("Write-Output 'nested pwsh -Command \"$true\"'"));
  assert.doesNotThrow(() => assertSafeCommand('Write-Output pwsh -Command "$true"'));
});

test('utf8Command: prepend на Windows, opt-out для cmd, ветки ОС', () => {
  const original = process.env.SHELL;
  try {
    if (process.platform !== 'win32') {
      assert.equal(utf8Command('Write-Output $true'), 'Write-Output $true');
      return;
    }
    const result = utf8Command('Write-Output $true');
    assert.ok(result.startsWith('[Console]::OutputEncoding=[Text.Encoding]::UTF8; '));
    assert.ok(result.endsWith('Write-Output $true'));
    process.env.SHELL = 'cmd';
    assert.equal(utf8Command('Write-Output $true'), 'Write-Output $true');
  } finally {
    if (original === undefined) delete process.env.SHELL;
    else process.env.SHELL = original;
  }
});
