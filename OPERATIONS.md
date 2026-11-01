# Unattended refresh

The owner-private Site provides `POST /api/scheduled`. It reads enabled/time preferences in D1, checks alternate-day Asia/Kolkata eligibility, records its last check and completed date, prevents overlapping runs, and completes a synchronous scraping job before returning. It skips when disabled, not due, already run that day, or without active suppliers. A failed supplier does not erase data.

An unattended task should obtain current owner-private service access from the Sites `get_site` operation for this Site. Use the current `siwc_bypass_bearer_token` only as `OAI-Sites-Authorization: Bearer ...` to the returned live Site origin. Do not print, persist, or place it in a URL or prompt. POST an empty JSON object to `/api/scheduled`, wait for its JSON result, then GET `/api/state` through the same authenticated service access to verify the new job and `settings.scheduler_last_checked`. No republishing is needed. Do not use a visitor's credentials or connected applications.

If the task cannot obtain supported service access, report the missing connection and do not change the Site's access policy. If status is unchanged or skipped, remain quiet. Notify for scraping failure, required user action or a meaningful new catalog / price change summary.

The preferred unattended task runs at 09:00 Asia/Kolkata on alternate days. The endpoint also checks date and time preferences, so duplicate calls are safe. If adjusting the configured execution time, update the linked task's cadence to the new time as well. Saving a preference alone cannot reschedule a Sites cloud task.

Manual `POST /api/run` accepts `{selected: [supplier IDs], wait: true}` for a synchronous external runner. The UI default uses a background response and polling; keep manual runs bounded. Large catalogs require a durable queue or per-source checkpointing before production scale. A lock from an interrupted Worker can be recovered after ten minutes through `POST /api/recover`.
