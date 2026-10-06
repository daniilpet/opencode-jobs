const key = 'opencodeJobsWorker';
const forbidden = new Set(['subagent', 'opencode_jobs_background', 'opencode_jobs_monitor', 'opencode_jobs_schedule', 'opencode_jobs_loop']);

export async function installWorkerGuards(ctx) {
  const workers = new Map();
  let closed = false;
  let cleaning;

  const stop = (sessionID, worker) => {
    if (worker.stopping) return worker.stopping;
    worker.stopping = (async () => {
      const errors = [];
      if (Date.now() >= worker.expiresAt) {
        try {
          const session = await ctx.session.get({ sessionID });
          const metadata = session.metadata;
          const limits = metadata?.[key];
          if (!limits || limits.jobID !== worker.jobID || limits.ownerSessionID !== worker.ownerSessionID || limits.expiresAt !== worker.expiresAt) {
            throw new Error('Изменилась принадлежность worker при остановке.');
          }
          if (!limits.terminal) await ctx.session.update({ sessionID, metadata: { ...metadata, [key]: { ...limits, terminal: true } } });
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await ctx.session.interrupt({ sessionID, resume: false });
        await ctx.session.wait({ sessionID });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, 'Не удалось полностью остановить worker.');
    })().finally(() => { worker.stopping = undefined; });
    return worker.stopping;
  };

  const arm = (sessionID, worker, delay) => {
    worker.timer = setTimeout(() => {
      if (!closed && Date.now() < worker.expiresAt) {
        arm(sessionID, worker, Math.min(worker.expiresAt - Date.now(), 2147483647));
        return;
      }
      // Ошибки фоновой отмены наблюдаемы; максимум три попытки без pump.
      void stop(sessionID, worker).catch((error) => {
        worker.failure = error;
        console.error('[opencode-jobs] Не удалось остановить worker:', sessionID, error);
        if (!closed && ++worker.retries < 3) arm(sessionID, worker, 1000);
      });
    }, delay);
    worker.timer.unref?.();
  };

  // Маркер отсутствует: штатное поведение. Некорректен: отказ.
  // terminal × expired: 00 разрешить до deadline; 01/10/11 отказ.
  // Закрытый lifecycle запрещает любой новый worker dispatch.
  const gate = async (event) => {
    const session = await ctx.session.get({ sessionID: event.sessionID });
    const limits = session.metadata?.[key];
    if (limits === undefined && !workers.has(event.sessionID)) return;
    if (!limits || typeof limits.jobID !== 'string' || !limits.jobID || typeof limits.ownerSessionID !== 'string' || !limits.ownerSessionID || limits.ownerSessionID === event.sessionID || !Number.isSafeInteger(limits.expiresAt) || limits.expiresAt <= 0 || typeof limits.terminal !== 'boolean') {
      throw new Error('Некорректная metadata worker.');
    }
    if (closed) throw new Error('Worker guards остановлены.');
    if (limits.terminal || Date.now() >= limits.expiresAt) throw new Error('Worker завершён или срок исполнения истёк.');
    let worker = workers.get(event.sessionID);
    if (worker && (worker.jobID !== limits.jobID || worker.ownerSessionID !== limits.ownerSessionID || worker.expiresAt !== limits.expiresAt)) throw new Error('Изменились неизменяемые metadata worker.');
    if (!worker) {
      worker = { ...limits, retries: 0 };
      workers.set(event.sessionID, worker);
      arm(event.sessionID, worker, Math.min(limits.expiresAt - Date.now(), 2147483647));
    }
    if (worker.failure) throw new Error('Остановка worker завершилась ошибкой.', { cause: worker.failure });
    if (event.tools) for (const tool of forbidden) delete event.tools[tool];
    if (forbidden.has(event.tool)) throw new Error('Вложенные задания и subagent запрещены для worker.');
    if (event.tool === 'shell') {
      if (!event.input || typeof event.input !== 'object') throw new Error('Некорректный input shell.');
      if (event.input.background === true) throw new Error('Background shell запрещён для worker.');
      const remaining = limits.expiresAt - Date.now();
      if (remaining <= 0) throw new Error('Срок исполнения worker истёк.');
      const timeout = event.input.timeout;
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) throw new Error('Некорректный timeout shell.');
      event.input.timeout = Math.min(timeout === 0 ? remaining : timeout ?? 120000, remaining);
    }
  };

  const registrations = [];
  try {
    registrations.push(await ctx.session.hook('context', gate));
    registrations.push(await ctx.session.hook('model.request', gate));
    registrations.push(await ctx.tool.hook('execute.before', gate));
  } catch (error) {
    closed = true;
    await Promise.all(registrations.map((registration) => registration.dispose()));
    throw error;
  }

  return () => {
    if (cleaning) return cleaning;
    closed = true;
    cleaning = (async () => {
      const results = await Promise.allSettled([...workers].map(async ([sessionID, worker]) => {
        try {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await stop(sessionID, worker);
              return;
            } catch (error) {
              if (attempt === 2) throw error;
            }
          }
        } finally {
          clearTimeout(worker.timer);
        }
      }));
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Не удалось остановить workers при cleanup.');
    })();
    return cleaning;
  };
}
