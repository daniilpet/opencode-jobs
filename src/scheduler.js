import { randomUUID } from 'node:crypto';

// Матрица восстановления: срок в будущем -> оставить; срок прошёл -> missed;
// shell launching/running -> interrupted без повторного запуска;
// завершённое/отменённое -> оставить. Outbox повторяется со стабильным message ID.
// Матрица тика (активно × срок): 00/01 -> нет запуска; 10 -> ждать; 11 -> очередь.
// Outbox (срок прошёл × admission подтверждён): 00/01 -> стабильный ID;
// 10 -> заменить запрос уведомлением missed; 11 -> сохранить принятый запрос.
// Cursor/окно монитора и outbox сохраняются одной записью. Отмена удаляет все pending ID.
export class Scheduler {
  constructor(io) {
    this.io = io;
    this.state = { version: 1, jobs: [], outbox: [], lastTick: 0 };
    this.serial = Promise.resolve();
    this.closed = false;
    this.saved = structuredClone(this.state);
  }

  assertActive() {
    if (this.closed) throw new Error('Экземпляр планировщика остановлен.');
    this.io.assertActive?.();
  }

  close() {
    this.closed = true;
    return this.serial;
  }

  run(action) {
    const result = this.serial.then(async () => {
      this.assertActive();
      try { return await action(); } catch (error) {
        this.state = structuredClone(this.saved);
        throw error;
      }
    });
    this.serial = result.catch(() => {});
    return result;
  }

  load(now) {
    return this.run(() => this.restore(now));
  }

  async restore(now) {
    const value = await this.io.load();
    this.assertActive();
    if (value !== undefined) {
      if (value.version !== 1 || !Array.isArray(value.jobs) || !Array.isArray(value.outbox)) throw new Error('Неизвестная версия или повреждение хранилища заданий.');
      this.state = structuredClone(value);
    }
    for (const job of this.state.jobs) {
      if (job.status !== 'active') continue;
      if (['background', 'monitor'].includes(job.kind)) {
        if (job.shellID && this.io.recoverShell && await this.io.recoverShell(job)) continue;
        job.status = 'interrupted';
        this.failure(job, 'Выполнение прервано перезапуском планировщика. Команда не запущена повторно; её прежний процесс мог успеть изменить данные.', now);
      } else if (job.due <= now) {
        this.miss(job, now);
      }
    }
    await this.persist();
  }

  async persist() {
    this.assertActive();
    const terminal = this.state.jobs.filter((job) => job.status !== 'active');
    const protectedIDs = new Set([...this.state.outbox.map((entry) => entry.jobID), ...this.state.jobs.filter((job) => job.messages?.length || job.deferredFailure).map((job) => job.id)]);
    const remove = new Set(terminal.filter((job) => !protectedIDs.has(job.id)).slice(0, Math.max(0, terminal.length - 50)).map((job) => job.id));
    this.state.jobs = this.state.jobs.filter((job) => !remove.has(job.id));
    await this.io.save(structuredClone(this.state));
    this.assertActive();
    this.saved = structuredClone(this.state);
  }

  add(sessionID, config, now, directory = '') {
    return this.run(async () => {
      if (!/^ses/.test(sessionID)) throw new Error('Некорректная сессия.');
      if (this.state.jobs.filter((job) => job.status === 'active').length >= 20 || this.state.outbox.length >= 100) throw new Error('Не более 20 активных заданий; перед новым заданием восстановите доставку.');
      const job = { ...config, id: `job_${randomUUID()}`, sessionID, directory, status: 'active', created: now, sequence: 0, coalesced: 0 };
      if (job.kind === 'loop') job.due = now + job.interval;
      this.state.jobs.push(job);
      try { await this.persist(); } catch (error) {
        this.state.jobs = this.state.jobs.filter((item) => item !== job);
        throw error;
      }
      return structuredClone(job);
    });
  }

  list(sessionID) {
    return this.run(() => structuredClone(this.state.jobs.filter((job) => job.sessionID === sessionID)));
  }

  all() {
    return this.run(() => structuredClone(this.state.jobs));
  }

  owned(sessionID, id) {
    const job = this.state.jobs.find((item) => item.id === id);
    if (!job) throw new Error('Задание не найдено.');
    if (job.sessionID !== sessionID) throw new Error('Задание принадлежит другой сессии.');
    return job;
  }

  update(sessionID, id, update) {
    return this.run(async () => {
      const job = this.owned(sessionID, id);
      Object.assign(job, update);
      await this.persist();
      return structuredClone(job);
    });
  }

  cancel(sessionID, id) {
    return this.run(async () => {
      const job = this.owned(sessionID, id);
      job.status = 'cancelled';
      this.state.outbox = this.state.outbox.filter((entry) => entry.jobID !== id);
      await this.persist();
      for (const message of job.messages ?? (job.lastMessage ? [job.lastMessage] : [])) {
        if (await this.io.isPending(sessionID, message)) await this.io.cancelDelivery(sessionID, message);
      }
      job.messages = [];
      delete job.deferredFailure;
      await this.persist();
      return structuredClone(job);
    });
  }

  enqueue(job, text, type, now) {
    if (this.state.outbox.length >= 100) throw new Error('Очередь заданий переполнена; требуется восстановить доставку.');
    const id = `msg_jobs_${job.id.slice(4).replaceAll('-', '')}_${++job.sequence}`;
    const entry = { id, jobID: job.id, sessionID: job.sessionID, type, text, created: now, due: job.due ?? now, coalesced: job.coalesced };
    this.state.outbox.push(entry);
    job.lastMessage = id;
    (job.messages ??= []).push(id);
    job.delivery = 'pending';
    return entry;
  }

  failure(job, reason, now) {
    job.error = reason;
    if (this.state.outbox.length >= 100) { job.deferredFailure = { reason, now }; return; }
    this.enqueue(job, `OpenCode jobs: задание ${job.id} (${job.kind}) не отработало. ${reason}\nПовторное исполнение не выполнено. Оцените причину и решите, нужно ли новое задание.`, 'failure', now);
  }

  miss(job, now) {
    const due = job.due;
    if (job.kind === 'schedule') job.status = 'missed';
    this.failure(job, `Срок пропущен: ${new Date(due).toISOString()}; задержка ${Math.max(0, now - due)} мс.`, now);
    if (job.kind === 'loop') job.due += (Math.floor((now - due) / job.interval) + 1) * job.interval;
  }

  report(sessionID, id, reason, now = Date.now(), status = 'failed') {
    return this.run(async () => {
      const job = this.owned(sessionID, id);
      if (job.status === 'cancelled') return;
      job.status = status;
      this.failure(job, reason, now);
      await this.persist();
    });
  }

  output(sessionID, id, text, now = Date.now()) {
    return this.run(async () => {
      const job = this.owned(sessionID, id);
      if (job.status !== 'active') return;
      this.enqueue(job, text, 'output', now);
      await this.persist();
    });
  }

  consume(sessionID, id, update, text, now) {
    return this.run(async () => {
      const job = this.owned(sessionID, id);
      if (job.status !== 'active') return;
      if (text) this.enqueue(job, text, 'output', now);
      Object.assign(job, update);
      await this.persist();
    });
  }

  async flush(now) {
    for (const entry of [...this.state.outbox]) {
      this.assertActive();
      const job = this.state.jobs.find((item) => item.id === entry.jobID);
      try {
        const current = this.io.now?.() ?? now;
        if (entry.type === 'prompt' && current - entry.due > 5000) {
          if (!await this.io.wasAdmitted(entry.sessionID, entry.id)) {
            this.state.outbox = this.state.outbox.filter((item) => item.id !== entry.id);
            job.messages = (job.messages ?? []).filter((id) => id !== entry.id);
            if (job.kind === 'schedule') job.status = 'missed';
            this.failure(job, `Срок пропущен при доставке: ${new Date(entry.due).toISOString()}; задержка ${current - entry.due} мс.`, current);
            await this.persist();
            continue;
          }
        } else {
          await this.io.deliver(entry);
        }
        this.assertActive();
        this.state.outbox = this.state.outbox.filter((item) => item.id !== entry.id);
        job.delivery = 'sent';
        delete job.deliveryError;
      } catch (error) {
        this.assertActive();
        job.delivery = 'failed';
        job.deliveryError = error instanceof Error ? error.message : String(error);
      }
      await this.persist();
    }
  }

  tick(now) {
    return this.run(async () => {
      await this.flush(now);
      for (const job of this.state.jobs) {
        const retained = [];
        for (const id of job.messages ?? []) {
          try {
            if (this.state.outbox.some((entry) => entry.id === id) || await this.io.isPending(job.sessionID, id)) retained.push(id);
          } catch (error) {
            job.deliveryError = error.message;
            retained.push(id);
          }
        }
        job.messages = retained;
        if (job.deferredFailure && this.state.outbox.length < 100) {
          const deferred = job.deferredFailure;
          delete job.deferredFailure;
          this.failure(job, deferred.reason, deferred.now);
        }
      }
      for (const job of this.state.jobs) {
        if (job.status !== 'active' || !['loop', 'schedule'].includes(job.kind) || job.due > now) continue;
        if (this.state.outbox.length >= 100) continue;
        if (now - job.due > 5000) {
          this.miss(job, now);
          continue;
        }
        const pending = this.state.outbox.some((entry) => entry.jobID === job.id) || job.messages?.length;
        if (job.kind === 'loop' && pending) {
          job.coalesced++;
        } else {
          this.enqueue(job, job.prompt, 'prompt', now);
          job.coalesced = 0;
        }
        if (job.kind === 'schedule') job.status = 'completed';
        else job.due += job.interval;
      }
      this.state.lastTick = now;
      await this.persist();
      await this.flush(now);
      return { jobs: this.state.jobs.length, pending: this.state.outbox.length, lastTick: now };
    });
  }
}
