-- oxy:deploy-phase=pre

CREATE TABLE "migration_items" (
	"job_id" text NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"destination" text DEFAULT 'mention' NOT NULL,
	"destination_id" text,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"source_created_at" timestamp with time zone,
	"payload" jsonb,
	"media_assets" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "migration_items_pkey" PRIMARY KEY("job_id","source_id"),
	CONSTRAINT "migration_items_kind_check" CHECK ("migration_items"."kind" in ('post', 'article', 'boost')),
	CONSTRAINT "migration_items_destination_check" CHECK ("migration_items"."destination" in ('mention')),
	CONSTRAINT "migration_items_status_check" CHECK ("migration_items"."status" in ('pending', 'deferred', 'sent', 'existing', 'failed', 'undone')),
	CONSTRAINT "migration_items_attempts_check" CHECK ("migration_items"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "migration_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"platform" text NOT NULL,
	"linked_account_id" text NOT NULL,
	"source_actor" text NOT NULL,
	"source_handle" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"phases" jsonb NOT NULL,
	"counters" jsonb NOT NULL,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"plan" jsonb DEFAULT '{"profile":null,"graph":null,"blocks":null}'::jsonb NOT NULL,
	"plan_ack" jsonb,
	"undo_facts" jsonb,
	"error" text,
	"paused_until" timestamp with time zone,
	"destination_undone" boolean DEFAULT false NOT NULL,
	"undo_result" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "migration_jobs_platform_check" CHECK ("migration_jobs"."platform" in ('mastodon', 'bluesky')),
	CONSTRAINT "migration_jobs_status_check" CHECK ("migration_jobs"."status" in ('queued', 'running', 'paused', 'done', 'failed', 'cancelled', 'undone'))
);
--> statement-breakpoint
ALTER TABLE "migration_items" ADD CONSTRAINT "migration_items_job_id_migration_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."migration_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "migration_items_job_status_idx" ON "migration_items" USING btree ("job_id","status","source_created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_jobs_one_active_per_user_platform" ON "migration_jobs" USING btree ("oxy_user_id","platform") WHERE "migration_jobs"."status" in ('queued', 'running', 'paused');--> statement-breakpoint
CREATE INDEX "migration_jobs_oxy_user_id_created_at_idx" ON "migration_jobs" USING btree ("oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "migration_jobs_active_idx" ON "migration_jobs" USING btree ("status","updated_at") WHERE "migration_jobs"."status" in ('queued', 'running', 'paused');