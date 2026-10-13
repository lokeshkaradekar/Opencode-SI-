# Thinking indicator fix v9

## Bug addressed
When opening a task/session that was still running, the header could show `SI task · working` but the chat transcript did not contain a live activity card. `openSession()` polled the running task without creating/passing an activity record. During app startup restoration, polling also began before the transcript restoration completed, allowing the activity card to be appended out of order.

## Changes
- Reopened running sessions now create a task-specific activity record based on the real server status and real reported steps.
- Polling receives that record so it transitions from Thinking to real tool activity and then to the actual terminal status.
- Startup restoration waits for the transcript restore before appending the activity record and starting the poll, preventing a stale Thinking row from appearing after the final response.

## Verification
Frontend tests and asset checks are run for this source package. Android/Sketchware device behavior still requires testing on the target phone.
