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
		CheckOrigin: func(r *http.Request) bool { return true }, // Настроить CORS!
	}
)

type MsgPacket struct {
	From       string `json:"from"`
	To         string `json:"to"`
	Ciphertext string `json:"ciphertext"`
	Nonce      string `json:"nonce"`
	Type       string `json:"type"`
	PublicKey  string `json:"public_key"`
	Avatar     string `json:"avatar"`
}

type User struct {
	Username     string `json:"username"`
	PublicKey    string `json:"public_key"`
	Avatar       string `json:"avatar"`
	UniqueKey    string `json:"unique_user_key"`
	Nickname     string `json:"nickname"`
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
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next(w, r)
	}
}

func main() {
	// Подключение к Redis и DB (в Docker эти данные берутся из ENV)
	redisAddr := getEnv("REDIS_ADDR", "localhost:6379")
	rdb = redis.NewClient(&redis.Options{Addr: redisAddr})

	dbHost := getEnv("DB_HOST", "localhost")
	dbPort := getEnv("DB_PORT", "5432")
	dbUser := getEnv("DB_USER", "user")
	dbPass := getEnv("DB_PASSWORD", "pass")
	dbName := getEnv("DB_NAME", "msg")
	dbSSLMode := getEnv("DB_SSLMODE", "disable")

	connStr := fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=%s", dbUser, dbPass, dbHost, dbPort, dbName, dbSSLMode)
	var err error
	db, err = sql.Open("postgres", connStr)
	if err != nil { log.Fatal(err) }

	// Эндпоинты
	http.HandleFunc("/socket.io", corsMiddleware(handleConnections))
	http.HandleFunc("/api/register", corsMiddleware(handleRegister))
	http.HandleFunc("/api/login", corsMiddleware(handleLogin))
	http.HandleFunc("/api/user", corsMiddleware(handleGetUser))
	http.HandleFunc("/api/search", corsMiddleware(handleSearchUser))
	http.HandleFunc("/api/contacts", corsMiddleware(handleContacts))
	http.HandleFunc("/api/add-contact", corsMiddleware(handleAddContact))
	http.HandleFunc("/api/offline-messages", corsMiddleware(handleOfflineMessages))
	http.HandleFunc("/api/update-profile", corsMiddleware(handleUpdateProfile))

	log.Println("Go Server started on :3005")
	http.ListenAndServe(":3005", nil)
}

// Регистрация пользователя
func handleRegister(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		PubKey   string `json:"pubkey"`
		Avatar   string `json:"avatar"`
		Nickname string `json:"nickname"`
	}

	log.Printf("Register request received. Method: %s", r.Method)

	// Try to parse JSON body first
	if r.Body != nil {
		err := json.NewDecoder(r.Body).Decode(&req)
		log.Printf("JSON decode error: %v, Username: %s", err, req.Username)
		if err == nil && req.Username != "" {
			// JSON body provided
			username := req.Username
			password := req.Password
			pubKey := req.PubKey
			avatar := req.Avatar
			nickname := req.Nickname

			log.Printf("Registering user: %s, avatar length: %d", username, len(avatar))

			hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
			if err != nil {
				log.Printf("Error hashing password: %v", err)
				http.Error(w, "Error hashing password", http.StatusInternalServerError)
				return
			}

			uniqueKey := generateUniqueKey()

			_, err = db.Exec("INSERT INTO users (username, password_hash, public_key, avatar, unique_user_key, nickname) VALUES ($1, $2, $3, $4, $5, $6)", username, hash, pubKey, avatar, uniqueKey, nickname)
			if err != nil {
				log.Printf("Error inserting user: %v", err)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusConflict)
				json.NewEncoder(w).Encode(map[string]string{"error": "User already exists"})
				return
			}

			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"unique_key": uniqueKey})
			return
		}
	}

	// Fallback to query parameters for backward compatibility
	username := r.URL.Query().Get("user")
	pubKey := r.URL.Query().Get("pubkey")
	avatar := r.URL.Query().Get("avatar")
	password := r.URL.Query().Get("password")

	log.Printf("Fallback to query params: %s", username)

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		log.Printf("Error hashing password: %v", err)
		http.Error(w, "Error hashing password", http.StatusInternalServerError)
		return
	}

	uniqueKey := generateUniqueKey()

	_, err = db.Exec("INSERT INTO users (username, password_hash, public_key, avatar, unique_user_key) VALUES ($1, $2, $3, $4, $5)", username, hash, pubKey, avatar, uniqueKey)
	if err != nil {
		log.Printf("Error inserting user: %v", err)
		http.Error(w, "Error registering user", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"unique_key": uniqueKey})
}

// Вход пользователя
func handleLogin(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("user")
	password := r.URL.Query().Get("password")

	var storedHash string
	err := db.QueryRow("SELECT password_hash FROM users WHERE username = $1", username).Scan(&storedHash)
	if err != nil {
		http.Error(w, "User not found", http.StatusNotFound)
		return
	}

	err = bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(password))
	if err != nil {
		http.Error(w, "Invalid password", http.StatusUnauthorized)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// Получение информации о пользователе по логину
func handleGetUser(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("user")

	var user User
	err := db.QueryRow("SELECT username, public_key, avatar, unique_user_key, nickname FROM users WHERE username = $1", username).Scan(&user.Username, &user.PublicKey, &user.Avatar, &user.UniqueKey, &user.Nickname)
	if err != nil {
		http.Error(w, "User not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(user)
}

// Поиск пользователя по уникальному ключу
func handleSearchUser(w http.ResponseWriter, r *http.Request) {
	uniqueKey := r.URL.Query().Get("key")

	var user User
	err := db.QueryRow("SELECT username, public_key, avatar, unique_user_key, nickname FROM users WHERE unique_user_key = $1", uniqueKey).Scan(&user.Username, &user.PublicKey, &user.Avatar, &user.UniqueKey, &user.Nickname)
	if err != nil {
		http.Error(w, "User not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(user)
}

// Получение контактов пользователя
func handleContacts(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("user")

	rows, err := db.Query(`
		SELECT c.contact_username, c.contact_public_key, c.contact_avatar, u.nickname 
		FROM contacts c 
		LEFT JOIN users u ON c.contact_username = u.username 
		WHERE c.user_username = $1
	`, username)
	if err != nil {
		http.Error(w, "Error fetching contacts", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type Contact struct {
		Username  string `json:"username"`
		PublicKey string `json:"public_key"`
		Avatar    string `json:"avatar"`
		Nickname  string `json:"nickname"`
	}

	var contacts []Contact
	for rows.Next() {
		var c Contact
		err := rows.Scan(&c.Username, &c.PublicKey, &c.Avatar, &c.Nickname)
		if err != nil {
			continue
		}
		contacts = append(contacts, c)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(contacts)
}

// Добавление контакта
func handleAddContact(w http.ResponseWriter, r *http.Request) {
	var req struct {
		UserUsername      string `json:"user_username"`
		ContactUsername   string `json:"contact_username"`
		ContactPublicKey  string `json:"contact_public_key"`
		ContactAvatar     string `json:"contact_avatar"`
	}

	if r.Body != nil {
		err := json.NewDecoder(r.Body).Decode(&req)
		if err != nil {
			http.Error(w, "Invalid request", http.StatusBadRequest)
			return
		}
	}

	_, err := db.Exec("INSERT INTO contacts (user_username, contact_username, contact_public_key, contact_avatar) VALUES ($1, $2, $3, $4) ON CONFLICT (user_username, contact_username) DO NOTHING",
		req.UserUsername, req.ContactUsername, req.ContactPublicKey, req.ContactAvatar)
	if err != nil {
		http.Error(w, "Error adding contact", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// Получение и удаление офлайн-сообщений
func handleOfflineMessages(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("user")

	type OfflineMessage struct {
		From       string `json:"from"`
		Ciphertext string `json:"ciphertext"`
		Nonce      string `json:"nonce"`
	}

	rows, err := db.Query("SELECT from_user, ciphertext, nonce FROM offline_messages WHERE to_user = $1", username)
	if err != nil {
		http.Error(w, "Error fetching offline messages", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var messages []OfflineMessage
	for rows.Next() {
		var msg OfflineMessage
		err := rows.Scan(&msg.From, &msg.Ciphertext, &msg.Nonce)
		if err != nil {
			continue
		}
		messages = append(messages, msg)
	}

	// Удаляем доставленные сообщения
	_, err = db.Exec("DELETE FROM offline_messages WHERE to_user = $1", username)
	if err != nil {
		log.Printf("Error deleting offline messages: %v", err)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(messages)
}

// Обновление профиля (ник и аватар)
func handleUpdateProfile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Nickname string `json:"nickname"`
		Avatar   string `json:"avatar"`
	}

	if r.Body != nil {
		err := json.NewDecoder(r.Body).Decode(&req)
		if err != nil {
			http.Error(w, "Invalid request", http.StatusBadRequest)
			return
		}
	}

	_, err := db.Exec("UPDATE users SET nickname = $1, avatar = $2 WHERE username = $3", req.Nickname, req.Avatar, req.Username)
	if err != nil {
		http.Error(w, "Error updating profile", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// Обработка WebSocket
func handleConnections(w http.ResponseWriter, r *http.Request) {
	user := r.URL.Query().Get("user")
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil { return }
	defer ws.Close()

	// Подписываемся на канал этого пользователя в Redis
	pubsub := rdb.Subscribe(ctx, "user:"+user)
	defer pubsub.Close()
	ch := pubsub.Channel()

	// Горутина для чтения из Redis и отправки в WebSocket
	go func() {
		for msg := range ch {
			ws.WriteMessage(websocket.TextMessage, []byte(msg.Payload))
		}
	}()

	// Чтение входящих сообщений из WebSocket
	for {
		_, msg, err := ws.ReadMessage()
		if err != nil { break }

		msgStr := string(msg)
		var packet MsgPacket

		// Парсим Socket.io формат: 42["event", {...}]
		if len(msgStr) > 2 && msgStr[:2] == "42" {
			var socketMsg []interface{}
			if err := json.Unmarshal([]byte(msgStr[2:]), &socketMsg); err == nil && len(socketMsg) == 2 {
				eventType := socketMsg[0].(string)
				packetBytes, _ := json.Marshal(socketMsg[1])
				json.Unmarshal(packetBytes, &packet)

				// Для contact_added уведомлений отправляем на целевого пользователя
				if eventType == "notification" && packet.Type == "contact_added" && packet.To != "" {
					packetBytes, _ = json.Marshal(packet)
					rdb.Publish(ctx, "user:"+packet.To, string(packetBytes))
					continue
				}
			}
		} else {
			json.Unmarshal(msg, &packet)
		}

		// Отправляем сообщение в Redis-канал получателя
		packetBytes, _ := json.Marshal(packet)
		receivers, _ := rdb.Publish(ctx, "user:"+packet.To, string(packetBytes)).Result()

		// Если получатель не в сети (никто не слушает канал в Redis), сохраняем в БД
		if receivers == 0 && packet.Ciphertext != "" {
			db.Exec("INSERT INTO offline_messages (from_user, to_user, ciphertext, nonce) VALUES ($1, $2, $3, $4)",
				packet.From, packet.To, packet.Ciphertext, packet.Nonce)
		}
	}
}