IF DB_ID('celerdemo') IS NULL CREATE DATABASE celerdemo;
GO
USE celerdemo;
GO
IF OBJECT_ID('dbo.pedidos') IS NOT NULL DROP TABLE dbo.pedidos;
IF OBJECT_ID('dbo.clientes') IS NOT NULL DROP TABLE dbo.clientes;
IF OBJECT_ID('dbo.v_resumen') IS NOT NULL DROP VIEW dbo.v_resumen;
GO
CREATE TABLE dbo.clientes (
  id INT IDENTITY PRIMARY KEY,
  nombre NVARCHAR(100) NOT NULL,
  email VARCHAR(150) NULL,
  ciudad NVARCHAR(60) NULL,
  alta DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
  saldo DECIMAL(12,2) NOT NULL DEFAULT 0,
  activo BIT NOT NULL DEFAULT 1,
  guid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
  notas NVARCHAR(MAX) NULL
);
CREATE TABLE dbo.pedidos (
  id BIGINT IDENTITY PRIMARY KEY,
  cliente_id INT NOT NULL REFERENCES dbo.clientes(id),
  fecha DATE NOT NULL,
  importe FLOAT NOT NULL,
  estado CHAR(1) NOT NULL,
  datos VARBINARY(16) NULL
);
CREATE INDEX ix_pedidos_cliente ON dbo.pedidos(cliente_id);
GO
;WITH n AS (SELECT TOP (10000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_objects a CROSS JOIN sys.all_objects b)
INSERT INTO dbo.clientes(nombre,email,ciudad,alta,saldo,activo,notas)
SELECT N'Cliente ' + CAST(i AS NVARCHAR(10)) + N' Ñandú',
       'cliente' + CAST(i AS VARCHAR(10)) + '@ejemplo.es',
       CHOOSE(1 + i % 5, N'Barcelona', N'Madrid', N'València', N'Sevilla', N'A Coruña'),
       DATEADD(MINUTE, -i * 37, SYSDATETIME()),
       (i % 1000) * 1.25,
       CASE WHEN i % 7 = 0 THEN 0 ELSE 1 END,
       CASE WHEN i % 3 = 0 THEN NULL ELSE N'Nota larga ' + REPLICATE(N'x', i % 200) END
FROM n;
GO
;WITH n AS (SELECT TOP (1000000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c)
INSERT INTO dbo.pedidos(cliente_id,fecha,importe,estado,datos)
SELECT 1 + i % 10000, DATEADD(DAY, -(i % 2000), CAST('2026-10-01' AS DATE)), (i % 5000) / 3.0,
       CHOOSE(1 + i % 3, 'A', 'P', 'C'), CASE WHEN i % 10 = 0 THEN CAST(i AS VARBINARY(16)) END
FROM n;
GO
CREATE VIEW dbo.v_resumen AS SELECT c.ciudad, COUNT(*) AS pedidos, SUM(p.importe) AS total FROM dbo.pedidos p JOIN dbo.clientes c ON c.id = p.cliente_id GROUP BY c.ciudad;
GO
CREATE OR ALTER PROCEDURE dbo.sp_top_clientes @n INT = 10 AS SELECT TOP (@n) c.nombre, SUM(p.importe) total FROM dbo.pedidos p JOIN dbo.clientes c ON c.id=p.cliente_id GROUP BY c.nombre ORDER BY total DESC;
GO
SELECT (SELECT COUNT(*) FROM dbo.clientes) clientes, (SELECT COUNT(*) FROM dbo.pedidos) pedidos;
