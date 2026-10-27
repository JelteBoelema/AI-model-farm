# Worker autoscaling (ECS Application Auto Scaling)

Workers scale on **queue depth**, not CPU: a video worker can idle at 2% CPU while waiting on a provider.

1. The scheduler worker publishes a CloudWatch metric `CreatorFarm/QueueBacklog` per queue
   (waiting + delayed jobs) every minute. *(Implemented in phase 10; until then use fixed counts.)*
2. Target-tracking policy per worker service, e.g. `generation`: target backlog per task = 20, min 1, max 6.
3. `publishing` stays at 1–2 tasks: platform rate limits, not compute, bound its throughput.
4. Scale-in protection: `stopTimeout: 120` plus graceful `SIGTERM` handling lets active jobs finish;
   anything interrupted is retried by BullMQ's stalled-job detection.

Starting sizes for 10–50 creators: web 2×(1 vCPU/2 GB), scheduler 1×(0.5/1), generation 1–4×(1/2),
media 1–3×(2/4), publishing 1×(0.5/1).
