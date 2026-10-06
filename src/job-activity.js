// Матрица active × runMessage × preparing × stopPending:
// 0000 -> исполнение завершено; остальные 15 сочетаний -> работа/остановка продолжается.
// workerResult сохраняется вместе с runMessage до завершения cleanup результата.
// Сохранённые shellID/workerID и ожидающие уведомления сами по себе не активность.
export function hasJobActivity(job) {
  return job.status === 'active' || Boolean(job.runMessage || job.preparing || job.stopPending);
}
