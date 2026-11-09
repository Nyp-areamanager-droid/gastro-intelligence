-- Rückfall für 004. Ein Enum-Wert lässt sich in PostgreSQL nicht entfernen;
-- „replaced“ bleibt als unbenutzter Wert stehen. Uploads mit diesem Status
-- werden auf „completed“ zurückgesetzt (ihre Kundendaten wurden beim Ersetzen
-- bereits entfernt, sie zählen also nicht doppelt).
BEGIN;
UPDATE public.uploads SET status = 'completed' WHERE status = 'replaced';
DROP INDEX IF EXISTS public.customers_company_ref_idx;
ALTER TABLE public.customers DROP COLUMN IF EXISTS customer_ref;
DROP INDEX IF EXISTS public.uploads_company_file_hash_idx;
ALTER TABLE public.uploads DROP CONSTRAINT IF EXISTS uploads_import_mode_check;
ALTER TABLE public.uploads DROP COLUMN IF EXISTS import_mode;
ALTER TABLE public.uploads DROP COLUMN IF EXISTS file_hash;
COMMIT;
