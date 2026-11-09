-- Rückfall für 005. Danach zeigt die App bis zum erneuten Einspielen keine
-- Einwohnerzahlen an (sie verlangt population_method).
BEGIN;
ALTER TABLE public.postal_codes DROP COLUMN IF EXISTS population_reference_date;
ALTER TABLE public.postal_codes DROP COLUMN IF EXISTS population_method;
COMMIT;
