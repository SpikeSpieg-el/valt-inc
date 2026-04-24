-- Create users table
CREATE TABLE IF NOT EXISTS users (
    username VARCHAR(255) PRIMARY KEY,
    password_hash VARCHAR(255) NOT NULL,
    public_key TEXT NOT NULL,
    avatar TEXT,
    unique_user_key VARCHAR(255) UNIQUE NOT NULL,
    nickname VARCHAR(255),
    encrypted_private_key TEXT,
    connection_code VARCHAR(8) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create offline_messages table
CREATE TABLE IF NOT EXISTS offline_messages (
    id SERIAL PRIMARY KEY,
    from_user VARCHAR(255) NOT NULL,
    to_user VARCHAR(255) NOT NULL,
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_user) REFERENCES users(username) ON DELETE CASCADE,
    FOREIGN KEY (to_user) REFERENCES users(username) ON DELETE CASCADE
);

-- Create contacts table
CREATE TABLE IF NOT EXISTS contacts (
    id SERIAL PRIMARY KEY,
    user_username VARCHAR(255) NOT NULL,
    contact_username VARCHAR(255) NOT NULL,
    contact_public_key TEXT NOT NULL,
    contact_avatar TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_username, contact_username),
    FOREIGN KEY (user_username) REFERENCES users(username) ON DELETE CASCADE,
    FOREIGN KEY (contact_username) REFERENCES users(username) ON DELETE CASCADE
);

-- Create messages_history table
CREATE TABLE IF NOT EXISTS messages_history (
    id SERIAL PRIMARY KEY,
    from_user TEXT,
    to_user TEXT,
    ciphertext TEXT,
    nonce TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_offline_messages_to_user ON offline_messages(to_user);
CREATE INDEX IF NOT EXISTS idx_offline_messages_created_at ON offline_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_contacts_user_username ON contacts(user_username);
CREATE INDEX IF NOT EXISTS idx_messages_history_from_user ON messages_history(from_user);
CREATE INDEX IF NOT EXISTS idx_messages_history_to_user ON messages_history(to_user);
CREATE INDEX IF NOT EXISTS idx_messages_history_created_at ON messages_history(created_at);
