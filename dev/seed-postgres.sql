-- Datos de ejemplo para probar Celer con PostgreSQL.
-- Idempotente: se puede volver a ejecutar (borra y recrea los objetos de demo).
--   psql -h localhost -p 54329 -U celer -d celer -f dev/seed-postgres.sql

SET client_encoding = 'UTF8';
SET client_min_messages = warning;

DROP SCHEMA IF EXISTS sales CASCADE;
DROP SCHEMA IF EXISTS inventory CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.mv_customer_totals CASCADE;
DROP VIEW IF EXISTS public.v_active_customers CASCADE;
DROP TABLE IF EXISTS public.events CASCADE;
DROP TABLE IF EXISTS public.type_showcase CASCADE;
DROP TABLE IF EXISTS public.customers CASCADE;
DROP TABLE IF EXISTS public.countries CASCADE;
DROP FUNCTION IF EXISTS public.full_name(text, text) CASCADE;
DROP FUNCTION IF EXISTS public.touch_updated_at() CASCADE;
DROP SEQUENCE IF EXISTS public.invoice_number_seq CASCADE;
DROP TYPE IF EXISTS public.customer_tier CASCADE;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────── public ─────────────
CREATE TYPE public.customer_tier AS ENUM ('bronze', 'silver', 'gold');

CREATE TABLE public.countries (
    code       char(2) PRIMARY KEY,
    name       varchar(80) NOT NULL UNIQUE,
    eu_member  boolean NOT NULL DEFAULT false
);
COMMENT ON TABLE public.countries IS 'Países (ISO 3166-1 alfa-2)';

INSERT INTO public.countries VALUES
 ('ES', 'España', true), ('PT', 'Portugal', true), ('FR', 'Francia', true),
 ('DE', 'Alemania', true), ('IT', 'Italia', true), ('GB', 'Reino Unido', false),
 ('US', 'Estados Unidos', false), ('MX', 'México', false), ('AR', 'Argentina', false),
 ('JP', 'Japón', false);

CREATE TABLE public.customers (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    first_name  text NOT NULL,
    last_name   text NOT NULL,
    email       varchar(200) NOT NULL,
    country     char(2) REFERENCES public.countries(code),
    tier        public.customer_tier NOT NULL DEFAULT 'bronze',
    credit      numeric(12,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    tags        text[],
    profile     jsonb,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz,
    CONSTRAINT customers_email_lower CHECK (email = lower(email))
);
CREATE UNIQUE INDEX customers_email_uq ON public.customers (email);
CREATE INDEX customers_country_idx ON public.customers (country, last_name);
CREATE INDEX customers_profile_gin ON public.customers USING gin (profile);
COMMENT ON COLUMN public.customers.credit IS 'Crédito disponible en EUR';

INSERT INTO public.customers (first_name, last_name, email, country, tier, credit, tags, profile, active, created_at)
SELECT fn, ln,
       lower(fn || '.' || ln || i || '@example.com'),
       (ARRAY['ES','PT','FR','DE','IT','GB','US','MX','AR','JP'])[1 + (i % 10)],
       (ARRAY['bronze','silver','gold'])[1 + (i % 3)]::public.customer_tier,
       round((random() * 5000)::numeric, 2),
       CASE WHEN i % 4 = 0 THEN NULL ELSE (ARRAY['vip', 'newsletter', 'b2b'])[1:(1 + i % 3)] END,
       CASE WHEN i % 5 = 0 THEN NULL
            ELSE jsonb_build_object('age', 20 + i % 50, 'lang', (ARRAY['es','en','pt'])[1 + i % 3], 'prefs', jsonb_build_object('dark', i % 2 = 0)) END,
       i % 7 <> 0,
       timestamptz '2024-01-01 00:00:00+00' + (i * interval '13 hours')
FROM generate_series(1, 500) AS i,
     LATERAL (SELECT (ARRAY['Ana','Luis','María','Jorge','Lucía','Pablo','Carmen','Javier','Elena','Diego'])[1 + i % 10] AS fn,
                     (ARRAY['García','Martínez','López','Sánchez','Pérez','Gómez','Fernández','Ruiz','Díaz','Moreno'])[1 + (i / 10) % 10] AS ln) n;

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
CREATE TRIGGER customers_touch BEFORE UPDATE ON public.customers
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.full_name(first text, last text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$ SELECT first || ' ' || last $fn$;

CREATE SEQUENCE public.invoice_number_seq START WITH 1000 INCREMENT BY 1;

CREATE VIEW public.v_active_customers AS
SELECT c.id, public.full_name(c.first_name, c.last_name) AS name, c.email, co.name AS country, c.tier, c.credit
FROM public.customers c LEFT JOIN public.countries co ON co.code = c.country
WHERE c.active;

-- Tabla con todos los tipos interesantes, incluidos NULLs.
CREATE TABLE public.type_showcase (
    id          serial PRIMARY KEY,
    c_smallint  smallint,
    c_int       integer,
    c_bigint    bigint,
    c_real      real,
    c_double    double precision,
    c_numeric   numeric(30,10),
    c_money     money,
    c_bool      boolean,
    c_char      char(5),
    c_varchar   varchar(50),
    c_text      text,
    c_uuid      uuid,
    c_json      json,
    c_jsonb     jsonb,
    c_date      date,
    c_time      time,
    c_timetz    timetz,
    c_ts        timestamp,
    c_tstz      timestamptz,
    c_interval  interval,
    c_bytea     bytea,
    c_int_arr   integer[],
    c_text_arr  text[],
    c_inet      inet,
    c_point     point,
    c_xml       xml,
    c_bits      bit varying(16),
    c_range     int4range,
    c_enum      public.customer_tier
);
INSERT INTO public.type_showcase (c_smallint, c_int, c_bigint, c_real, c_double, c_numeric, c_money, c_bool, c_char, c_varchar, c_text,
    c_uuid, c_json, c_jsonb, c_date, c_time, c_timetz, c_ts, c_tstz, c_interval, c_bytea, c_int_arr, c_text_arr, c_inet, c_point, c_xml, c_bits, c_range, c_enum)
VALUES
 (1, 42, 9007199254740993, 1.5, 3.141592653589793, 12345678901234567890.0123456789, 19.99, true, 'abc', 'hola', 'texto largo ñ €',
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '{"a": 1}', '{"b": [1, 2, 3]}', '2026-10-07', '13:45:10', '13:45:10+02', '2026-10-07 13:45:10.123456',
  '2026-10-07 13:45:10+02', '1 day 02:03:04', '\xDEADBEEF', '{1,2,3}', '{"x","y z"}', '192.168.1.10/24', '(1.5,2)', '<a>1</a>', B'1011', '[1,10)', 'gold'),
 (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
 (-32768, -2147483648, -9223372036854775808, 'NaN', 'Infinity', -0.0000000001, -1, false, '', '', '', '00000000-0000-0000-0000-000000000000',
  '[]', 'null', '0001-01-01', '00:00:00', '00:00:00+00', '1970-01-01 00:00:00', '1970-01-01 00:00:00+00', '-1 mons', '\x', '{}', '{NULL}', '::1', '(0,0)', '<x/>', B'', 'empty', 'bronze');

-- Tabla grande para probar el paginado (~200k filas).
CREATE TABLE public.events (
    id          bigint PRIMARY KEY,
    customer_id bigint REFERENCES public.customers(id),
    kind        text NOT NULL CHECK (kind IN ('view', 'click', 'purchase', 'signup')),
    amount      numeric(10,2),
    payload     jsonb,
    happened_at timestamptz NOT NULL
);
INSERT INTO public.events (id, customer_id, kind, amount, payload, happened_at)
SELECT g,
       1 + (g % 500),
       (ARRAY['view','click','purchase','signup'])[1 + (g % 4)],
       CASE WHEN g % 4 = 2 THEN round((random() * 300)::numeric, 2) END,
       jsonb_build_object('seq', g, 'src', (ARRAY['web','ios','android'])[1 + (g % 3)]),
       timestamptz '2025-01-01 00:00:00+00' + g * interval '2 minutes'
FROM generate_series(1, 200000) AS g;
CREATE INDEX events_customer_idx ON public.events (customer_id, happened_at DESC);
CREATE INDEX events_kind_idx ON public.events (kind) WHERE kind = 'purchase';

CREATE MATERIALIZED VIEW public.mv_customer_totals AS
SELECT e.customer_id, count(*) AS events, sum(e.amount) AS revenue
FROM public.events e GROUP BY e.customer_id
WITH DATA;
CREATE UNIQUE INDEX mv_customer_totals_pk ON public.mv_customer_totals (customer_id);

-- ───────────── sales ─────────────
CREATE SCHEMA sales;
COMMENT ON SCHEMA sales IS 'Ventas y facturación';

CREATE TABLE sales.products (
    sku         varchar(20) PRIMARY KEY,
    name        text NOT NULL,
    price       numeric(10,2) NOT NULL CHECK (price > 0),
    stock       integer NOT NULL DEFAULT 0,
    attributes  jsonb NOT NULL DEFAULT '{}',
    image       bytea,
    discontinued boolean NOT NULL DEFAULT false
);
INSERT INTO sales.products (sku, name, price, stock, attributes, image) VALUES
 ('KB-001', 'Teclado mecánico', 89.90, 120, '{"layout": "ES", "switch": "brown"}', '\x89504E470D0A1A0A'),
 ('MS-002', 'Ratón inalámbrico', 29.50, 300, '{"dpi": 1600}', NULL),
 ('MN-27Q', 'Monitor 27" QHD', 329.00, 45, '{"hz": 144, "panel": "IPS"}', NULL),
 ('HD-USB', 'Hub USB-C 7 en 1', 45.00, 0, '{}', NULL),
 ('CB-HDM', 'Cable HDMI 2.1 (2 m)', 12.99, 800, '{"length_m": 2}', '\x00FF');

CREATE TABLE sales.orders (
    id          integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    number      bigint NOT NULL DEFAULT nextval('public.invoice_number_seq') UNIQUE,
    customer_id bigint NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','shipped','cancelled')),
    ordered_at  timestamptz NOT NULL DEFAULT now(),
    notes       text
);
CREATE INDEX orders_customer_idx ON sales.orders (customer_id);

CREATE TABLE sales.order_lines (
    order_id    integer NOT NULL REFERENCES sales.orders(id) ON DELETE CASCADE,
    line_no     smallint NOT NULL,
    sku         varchar(20) NOT NULL REFERENCES sales.products(sku),
    quantity    integer NOT NULL CHECK (quantity > 0),
    unit_price  numeric(10,2) NOT NULL,
    PRIMARY KEY (order_id, line_no)
);

INSERT INTO sales.orders (customer_id, status, ordered_at, notes)
SELECT 1 + (i * 7) % 500, (ARRAY['pending','paid','shipped','cancelled'])[1 + i % 4],
       timestamptz '2026-01-01 09:00:00+01' + i * interval '5 hours',
       CASE WHEN i % 6 = 0 THEN 'Entregar por la tarde' END
FROM generate_series(1, 300) AS i;

INSERT INTO sales.order_lines (order_id, line_no, sku, quantity, unit_price)
SELECT o.id, l, p.sku, 1 + (o.id + l) % 4, p.price
FROM sales.orders o
CROSS JOIN generate_series(1, 3) AS l
JOIN LATERAL (SELECT sku, price FROM sales.products ORDER BY sku OFFSET ((o.id + l) % 5) LIMIT 1) p ON true
WHERE l <= 1 + o.id % 3;

CREATE VIEW sales.v_order_totals AS
SELECT o.id, o.number, o.customer_id, o.status, sum(l.quantity * l.unit_price) AS total
FROM sales.orders o JOIN sales.order_lines l ON l.order_id = o.id
GROUP BY o.id;

CREATE FUNCTION sales.order_total(p_order integer) RETURNS numeric
LANGUAGE plpgsql STABLE AS $$
DECLARE t numeric;
BEGIN
    SELECT coalesce(sum(quantity * unit_price), 0) INTO t FROM sales.order_lines WHERE order_id = p_order;
    RAISE NOTICE 'Pedido % suma %', p_order, t;
    RETURN t;
END;
$$;

CREATE PROCEDURE sales.cancel_order(p_order integer)
LANGUAGE sql AS $$ UPDATE sales.orders SET status = 'cancelled' WHERE id = p_order $$;

CREATE SEQUENCE sales.ticket_seq AS integer START 1 INCREMENT 5 MAXVALUE 100000 CYCLE;

-- Nombres incómodos para probar el entrecomillado.
CREATE TABLE sales."Mixed Case ""Table""" ("Id" int PRIMARY KEY, "select" text);
INSERT INTO sales."Mixed Case ""Table""" VALUES (1, 'palabra reservada');

ANALYZE;
