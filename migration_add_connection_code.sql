-- Добавление поля connection_code в таблицу users
ALTER TABLE users ADD COLUMN connection_code VARCHAR(8);

-- Генерация connection_code для существующих пользователей
UPDATE users SET connection_code = SUBSTRING(MD5(unique_user_key), 1, 8) WHERE connection_code IS NULL;

-- Добавление уникального индекса для connection_code
CREATE UNIQUE INDEX idx_connection_code ON users(connection_code);

-- Установка NOT NULL constraint после заполнения данных
ALTER TABLE users ALTER COLUMN connection_code SET NOT NULL;
