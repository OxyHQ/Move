-- oxy:deploy-phase=pre
ALTER TABLE "migration_jobs" ADD COLUMN "oxy_task_id" text;--> statement-breakpoint
ALTER TABLE "migration_jobs" ADD COLUMN "undo_task_id" text;