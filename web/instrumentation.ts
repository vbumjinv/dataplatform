export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { initializeIngestionScheduler } = await import("./app/api/ingestion/scheduler");
  const { initializePipelineScheduler } = await import("./app/api/pipeline/_lib/pipeline-scheduler");
  const { initializeNewsStockScheduler } = await import("./app/api/ingestion/_lib/news-stock-scheduler");
  const { initializeDartScheduler } = await import("./app/api/ingestion/_lib/dart-scheduler");
  const { initializeNytScheduler } = await import("./app/api/ingestion/_lib/nyt-scheduler");
  const { initializeKospiForecastScheduler } = await import("./app/api/kospi-forecast/_lib/scheduler");
  await initializeIngestionScheduler();
  await initializePipelineScheduler();
  await initializeNewsStockScheduler();
  await initializeDartScheduler();
  await initializeNytScheduler();
  await initializeKospiForecastScheduler();
}
