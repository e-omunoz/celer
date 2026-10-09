DROP DATABASE IF EXISTS celerdemo;
CREATE DATABASE celerdemo WITH LOG;
CREATE TABLE clientes (
  id SERIAL PRIMARY KEY,
  nombre NVARCHAR(100) NOT NULL,
  email VARCHAR(150),
  ciudad VARCHAR(60),
  alta DATETIME YEAR TO SECOND DEFAULT CURRENT YEAR TO SECOND,
  saldo DECIMAL(12,2) DEFAULT 0,
  activo BOOLEAN DEFAULT 't',
  notas LVARCHAR(2000)
);
CREATE TABLE pedidos (
  id BIGSERIAL PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  fecha DATE NOT NULL,
  importe FLOAT NOT NULL,
  estado CHAR(1) NOT NULL
);
-- No CREATE INDEX on pedidos(cliente_id): Informix indexes a REFERENCES column itself (a second one fails with -350).
CREATE PROCEDURE carga()
  DEFINE i INTEGER;
  FOR i = 1 TO 5000
    INSERT INTO clientes(nombre,email,ciudad,saldo,activo,notas) VALUES ('Cliente ' || i, 'cliente' || i || '@ejemplo.es',
      DECODE(MOD(i,5),0,'Barcelona',1,'Madrid',2,'Valencia',3,'Sevilla','A Coruna'), MOD(i,1000)*1.25,
      DECODE(MOD(i,7),0,'f','t'), DECODE(MOD(i,3),0,NULL,'Nota ' || i));
  END FOR;
  FOR i = 1 TO 100000
    INSERT INTO pedidos(cliente_id,fecha,importe,estado) VALUES (1 + MOD(i,5000), TODAY - MOD(i,2000), MOD(i,5000)/3.0, DECODE(MOD(i,3),0,'A',1,'P','C'));
  END FOR;
END PROCEDURE;
EXECUTE PROCEDURE carga();
CREATE VIEW v_resumen(ciudad, pedidos, total) AS SELECT c.ciudad, COUNT(*), SUM(p.importe) FROM pedidos p, clientes c WHERE c.id = p.cliente_id GROUP BY c.ciudad;
SELECT COUNT(*) FROM pedidos;
