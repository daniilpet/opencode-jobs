const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
const horizon = 30 * units.d;

export function duration(raw) {
  if (!/^(?:\d+(?:\.\d+)?[smhd])+$/i.test(raw)) throw new Error('Некорректная длительность; пример: 10s, 5m, 1h30m.');
  const value = [...raw.matchAll(/(\d+(?:\.\d+)?)([smhd])/gi)].reduce((sum, item) => sum + Number(item[1]) * units[item[2].toLowerCase()], 0);
  if (!Number.isSafeInteger(value) || value <= 0 || value > horizon) throw new Error('Длительность должна быть положительной и не более 30 дней.');
  return value;
}

function tokens(raw) {
  const result = [];
  const expression = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = expression.exec(raw))) result.push(match[1]?.replace(/\\(["\\])/g, '$1') ?? match[2] ?? match[3]);
  return result;
}

export function parse(name, raw = '', now = Date.now()) {
  raw = raw.trim();
  if (raw.length > 32768) throw new Error('Аргументы превышают 32 КиБ.');
  if (name === 'background') {
    if (!raw) throw new Error('Нужна shell-команда.');
    return { kind: 'background', command: raw };
  }
  if (name === 'monitor') {
    const expression = /"(?:\\.|[^"\\])*"|'[^']*'|\S+/g;
    let separator;
    let part;
    while ((part = expression.exec(raw))) {
      if (part[0] === '--') { separator = { index: part.index, length: part[0].length }; break; }
    }
    if (!separator) throw new Error('Используйте --regex <выражение> -- <команда>.');
    const command = raw.slice(separator.index + separator.length).trim();
    if (!command) throw new Error('Нужна shell-команда.');
    const args = tokens(raw.slice(0, separator.index));
    const config = { kind: 'monitor', pattern: '', before: 3, after: 3, debounce: 5000, command };
    const seen = new Set();
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i];
      const value = args[i + 1];
      if (!['--regex', '--before', '--after', '--debounce'].includes(key) || value === undefined || seen.has(key)) throw new Error(`Некорректный параметр монитора: ${key}.`);
      seen.add(key);
      if (key === '--regex') {
        if (!value || value.length > 256) throw new Error('Регулярное выражение должно содержать от 1 до 256 символов.');
        new RegExp(value);
        config.pattern = value;
      } else {
        if (!/^\d+$/.test(value)) throw new Error(`Некорректный параметр: ${key}.`);
        const number = Number(value);
        const maximum = key === '--debounce' ? 60 : 50;
        const minimum = key === '--debounce' ? 1 : 0;
        if (number < minimum || number > maximum) throw new Error(`Параметр ${key}: от ${minimum} до ${maximum}.`);
        config[key.slice(2)] = key === '--debounce' ? number * 1000 : number;
      }
    }
    if (!config.pattern) throw new Error('Нужен параметр --regex.');
    return config;
  }
  if (name === 'loop') {
    const match = /^(\S+)\s+([\s\S]+)$/.exec(raw);
    if (!match) throw new Error('Используйте /loop <интервал> <запрос>.');
    const interval = duration(match[1]);
    if (interval < 10000) throw new Error('Минимальный интервал: 10 секунд.');
    return { kind: 'loop', interval, prompt: match[2] };
  }
  if (name === 'schedule') {
    const match = /^(in|at)\s+(\S+)\s+([\s\S]+)$/.exec(raw);
    if (!match) throw new Error('Используйте /schedule in <длительность> <запрос> или at <ISO-дата с поясом> <запрос>.');
    if (match[1] === 'at' && !/(?:Z|[+-]\d{2}:\d{2})$/.test(match[2])) throw new Error('ISO-дата должна явно задавать часовой пояс.');
    const due = match[1] === 'in' ? now + duration(match[2]) : Date.parse(match[2]);
    if (!Number.isFinite(due) || due <= now) throw new Error('Дата должна быть корректной и находиться в будущем.');
    if (due - now > horizon) throw new Error('Максимальный горизонт расписания: 30 дней.');
    return { kind: 'schedule', due, prompt: match[3] };
  }
  if (name === 'jobs') return { kind: 'jobs' };
  if (name === 'cancel') {
    if (!/^job_[a-f0-9-]+$/.test(raw)) throw new Error('Укажите идентификатор job_ из /jobs.');
    return { kind: 'cancel', id: raw };
  }
  throw new Error(`Неизвестная команда: ${name}.`);
}
