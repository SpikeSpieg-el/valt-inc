package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/go-redis/redis/v8"
	"github.com/gorilla/websocket"
	"golang.org/x/crypto/bcrypt"
	_ "github.com/lib/pq"
)

var (
	rdb *redis.Client
	db  *sql.DB
	ctx = context.Background()
	upgrader = websocket.Upgrader{
		ReadBufferSize:  1024 * 10,
		WriteBufferSize: 1024 * 10,
		CheckOrigin: func(r *http.Request) bool {
			// Разрешаем все origin для работы фронтенда
			return true
		},
	}
)

type MsgPacket struct {
	From       string `json:"from"`
	To         string `json:"to"`
	Ciphertext string `json:"ciphertext"`
	Nonce      string `json:"nonce"`
	Type       string `json:"type"`
	PublicKey  string `json:"public_key,omitempty"`
	Avatar     string `json:"avatar,omitempty"`
	Nickname   string `json:"nickname,omitempty"`
	Username   string `json:"username,omitempty"`
}

type User struct {
	Username            string `json:"username"`
	PublicKey           string `json:"public_key"`
	Avatar              string `json:"avatar"`
	UniqueKey           string `json:"unique_user_key"`
	Nickname            string `json:"nickname"`
	EncryptedPrivateKey string `json:"encrypted_private_key"`
}

func generateUniqueKey() string {
	b := make([]byte, 16)
	rand.Read(b)
	return base64.URLEncoding.EncodeToString(b)
}

func getEnv(key, defaultValue string) string {
	value := os.Getenv(key)
	if value == "" {
		return defaultValue
	}
	return value
}

func corsMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization")
		w.Header().Set("Access-Control-Allow-Credentials", "true")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next(w, r)
	}
}

func main() {
	// Инициализация Redis
	redisAddr := getEnv("REDIS_ADDR", "localhost:6379")
	rdb = redis.NewClient(&redis.Options{Addr: redisAddr})

	// Инициализация БД
	dbHost := getEnv("DB_HOST", "localhost")
	dbPort := getEnv("DB_PORT", "5432")
	dbUser := getEnv("DB_USER", "user")
	dbPass := getEnv("DB_PASSWORD", "pass")
	dbName := getEnv("DB_NAME", "msg")
	dbSSLMode := getEnv("DB_SSLMODE", "disable")

	connStr := fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=%s", dbUser, dbPass, dbHost, dbPort, dbName, dbSSLMode)
	var err error
	db, err = sql.Open("postgres", connStr)
	if err != nil {
		log.Fatal("DB Connection Error:", err)
	}

	// Маршруты
	http.HandleFunc("/ws", handleConnections)
	http.HandleFunc("/api/register", corsMiddleware(handleRegister))
	http.HandleFunc("/api/login", corsMiddleware(handleLogin))
	http.HandleFunc("/api/user", corsMiddleware(handleGetUser))
	http.HandleFunc("/api/search", corsMiddleware(handleSearchUser))
	http.HandleFunc("/api/contacts", corsMiddleware(handleContacts))
	http.HandleFunc("/api/add-contact", corsMiddleware(handleAddContact))
	http.HandleFunc("/api/offline-messages", corsMiddleware(handleOfflineMessages))
	http.HandleFunc("/api/update-profile", corsMiddleware(handleUpdateProfile))
	http.HandleFunc("/api/history", corsMiddleware(handleHistory))

	log.Println("🚀 Full E2EE Server started on :3005")
	log.Fatal(http.ListenAndServe(":3005", nil))
}

func handleRegister(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username            string `json:"username"`
		Password            string `json:"password"`
		PubKey              string `json:"pubkey"`
		Avatar              string `json:"avatar"`
		Nickname            string `json:"nickname"`
		EncryptedPrivateKey string `json:"encrypted_private_key"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	log.Printf("📝 New registration: %s", req.Username)

	hash, _ := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	uniqueKey := generateUniqueKey()

	_, err := db.Exec(`INSERT INTO users (username, password_hash, public_key, avatar, unique_user_key, nickname, encrypted_private_key) 
		VALUES ($1, $2, $3, $4, $5, $6, $7)`, 
		req.Username, string(hash), req.PubKey, req.Avatar, uniqueKey, req.Nickname, req.EncryptedPrivateKey)

	if err != nil {
		log.Printf("❌ Register error: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{"error": "User already exists"})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"unique_key": uniqueKey})
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	log.Printf("🔑 Login attempt: %s", req.Username)

	var storedHash string
	err := db.QueryRow("SELECT password_hash FROM users WHERE username = $1", req.Username).Scan(&storedHash)
	if err != nil {
		http.Error(w, "User not found", http.StatusNotFound)
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(req.Password)); err != nil {
		http.Error(w, "Invalid password", http.StatusUnauthorized)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleGetUser(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("user")
	var u User
	// Используем COALESCE для всех полей, которые могут быть NULL
	err := db.QueryRow(`
		SELECT username, public_key, COALESCE(avatar, ''), unique_user_key, 
		       COALESCE(nickname, ''), COALESCE(encrypted_private_key, '') 
		FROM users WHERE username = $1`, username).Scan(
		&u.Username, &u.PublicKey, &u.Avatar, &u.UniqueKey, &u.Nickname, &u.EncryptedPrivateKey)
	
	if err != nil {
		log.Printf("❌ User data not found: %s", username)
		http.Error(w, "User not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(u)
}

func handleSearchUser(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	var u User
	err := db.QueryRow(`
		SELECT username, public_key, COALESCE(avatar, ''), unique_user_key, COALESCE(nickname, '') 
		FROM users WHERE unique_user_key = $1`, key).Scan(
		&u.Username, &u.PublicKey, &u.Avatar, &u.UniqueKey, &u.Nickname)
	
	if err != nil {
		http.Error(w, "User not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(u)
}

func handleAddContact(w http.ResponseWriter, r *http.Request) {
	var req struct {
		UserUsername     string `json:"user_username"`
		ContactUsername  string `json:"contact_username"`
		ContactPublicKey string `json:"contact_public_key"`
		ContactAvatar    string `json:"contact_avatar"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Bad JSON", http.StatusBadRequest)
		return
	}

	log.Printf("🤝 Adding contact: %s <-> %s", req.UserUsername, req.ContactUsername)

	// 1. Добавляем контакт тому, кто инициировал поиск
	_, err := db.Exec(`INSERT INTO contacts (user_username, contact_username, contact_public_key, contact_avatar) 
		VALUES ($1, $2, $3, $4) ON CONFLICT (user_username, contact_username) 
		DO UPDATE SET contact_public_key = $3, contact_avatar = $4`,
		req.UserUsername, req.ContactUsername, req.ContactPublicKey, req.ContactAvatar)

	// 2. Автоматически добавляем обратный контакт второму пользователю
	var aPubKey, aAvatar, aNickname string
	err = db.QueryRow(`SELECT public_key, COALESCE(avatar, ''), COALESCE(nickname, '') 
	                    FROM users WHERE username = $1`, req.UserUsername).Scan(&aPubKey, &aAvatar, &aNickname)
	
	if err == nil {
		db.Exec(`INSERT INTO contacts (user_username, contact_username, contact_public_key, contact_avatar) 
			VALUES ($1, $2, $3, $4) ON CONFLICT (user_username, contact_username) 
			DO UPDATE SET contact_public_key = $3, contact_avatar = $4`,
			req.ContactUsername, req.UserUsername, aPubKey, aAvatar)

		// Уведомляем друга по WebSocket, что его добавили
		notif, _ := json.Marshal(MsgPacket{
			Type:      "contact_added",
			From:      req.UserUsername,
			PublicKey: aPubKey,
			Avatar:    aAvatar,
			Nickname:  aNickname,
		})
		rdb.Publish(ctx, "user:"+req.ContactUsername, string(notif))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleContacts(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("user")
	rows, err := db.Query(`
		SELECT c.contact_username, c.contact_public_key, COALESCE(u.avatar, ''), COALESCE(u.nickname, '') 
		FROM contacts c JOIN users u ON c.contact_username = u.username 
		WHERE c.user_username = $1`, username)
	
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]interface{}{})
		return
	}
	defer rows.Close()

	contacts := make([]MsgPacket, 0) // Инициализируем пустым списком []
	for rows.Next() {
		var c MsgPacket
		if err := rows.Scan(&c.Username, &c.PublicKey, &c.Avatar, &c.Nickname); err == nil {
			contacts = append(contacts, c)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(contacts)
}

func handleUpdateProfile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Nickname string `json:"nickname"`
		Avatar   string `json:"avatar"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	log.Printf("👤 Profile update: %s", req.Username)
	db.Exec("UPDATE users SET nickname = $1, avatar = $2 WHERE username = $3", req.Nickname, req.Avatar, req.Username)
	db.Exec("UPDATE contacts SET contact_avatar = $1 WHERE contact_username = $2", req.Avatar, req.Username)

	// Уведомляем друзей об обновлении
	rows, _ := db.Query("SELECT user_username FROM contacts WHERE contact_username = $1", req.Username)
	defer rows.Close()
	for rows.Next() {
		var friend string
		rows.Scan(&friend)
		notif, _ := json.Marshal(map[string]interface{}{
			"type": "profile_updated", "username": req.Username, "nickname": req.Nickname, "avatar": req.Avatar,
		})
		rdb.Publish(ctx, "user:"+friend, string(notif))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleOfflineMessages(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("user")
	rows, err := db.Query("SELECT from_user, ciphertext, nonce FROM offline_messages WHERE to_user = $1", username)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]interface{}{})
		return
	}
	defer rows.Close()

	msgs := make([]MsgPacket, 0)
	for rows.Next() {
		var m MsgPacket
		if err := rows.Scan(&m.From, &m.Ciphertext, &m.Nonce); err == nil {
			msgs = append(msgs, m)
		}
	}
	// Очищаем доставленное
	db.Exec("DELETE FROM offline_messages WHERE to_user = $1", username)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(msgs)
}

func handleHistory(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("user")
	log.Printf("📜 Fetching history: %s", username)

	rows, err := db.Query(`SELECT from_user, to_user, ciphertext, nonce 
		FROM messages_history WHERE from_user = $1 OR to_user = $1 
		ORDER BY created_at ASC`, username)
	
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]MsgPacket{})
		return
	}
	defer rows.Close()

	msgs := make([]MsgPacket, 0)
	for rows.Next() {
		var m MsgPacket
		if err := rows.Scan(&m.From, &m.To, &m.Ciphertext, &m.Nonce); err == nil {
			msgs = append(msgs, m)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(msgs)
}

func handleConnections(w http.ResponseWriter, r *http.Request) {
	user := r.URL.Query().Get("user")
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WS error: %v", err)
		return
	}
	defer ws.Close()

	log.Printf("🔌 WS connected: %s", user)

	pubsub := rdb.Subscribe(ctx, "user:"+user)
	defer pubsub.Close()

	// Чтение из Redis -> Отправка в WS
	go func() {
		for msg := range pubsub.Channel() {
			ws.WriteMessage(websocket.TextMessage, []byte(msg.Payload))
		}
	}()

	// Чтение из WS -> Рассылка в Redis
	for {
		_, msg, err := ws.ReadMessage()
		if err != nil { break }

		var p MsgPacket
		if err := json.Unmarshal(msg, &p); err != nil { continue }

		pBytes, _ := json.Marshal(p)
		
		// Пытаемся доставить онлайн
		receivers, _ := rdb.Publish(ctx, "user:"+p.To, string(pBytes)).Result()

		// Сохраняем в историю (всегда)
		if p.Ciphertext != "" {
			db.Exec("INSERT INTO messages_history (from_user, to_user, ciphertext, nonce) VALUES ($1, $2, $3, $4)",
				p.From, p.To, p.Ciphertext, p.Nonce)
		}

		// Если получатель оффлайн (никто не слушает Redis), кладем в оффлайн-таблицу
		if receivers == 0 && p.Ciphertext != "" {
			db.Exec("INSERT INTO offline_messages (from_user, to_user, ciphertext, nonce) VALUES ($1, $2, $3, $4)",
				p.From, p.To, p.Ciphertext, p.Nonce)
		}
	}
}