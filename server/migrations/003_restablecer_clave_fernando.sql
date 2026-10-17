-- Restablece una sola vez la contraseña del usuario administrador inicial a una
-- clave temporal (sólo se guarda su hash bcrypt). Al ingresar, el sistema obliga
-- a crear una contraseña nueva. En una instalación nueva no afecta a nadie,
-- porque las migraciones se aplican antes de crear el usuario inicial.
UPDATE usuarios
SET password_hash = '$2b$12$mtmeVoGuYwkp8GOZS5OWwugsq5rNj1rrSqAzPnmBp5r0ndQUiCYkS',
    debe_cambiar_password = 1,
    activo = 1,
    actualizado_en = datetime('now')
WHERE usuario = 'fernando';
