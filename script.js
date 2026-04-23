/**
 * ГЛОБАЛЬНОЕ СОСТОЯНИЕ ПРИЛОЖЕНИЯ (STATE)
 */
const State = {
    myKeys: null,            // Объект с публичным и приватным ключами
    myUsername: "",          // Логин (ID)
    myNickname: "",          // Отображаемое имя
    myUniqueKey: "",         // Уникальный ключ для поиска
    myAvatarBase64: "",      // Аватар в base64
    contacts: {},            // { username: { publicKey, avatar, displayName } }
    chatHistory: {},         // { username: [ {text, type, senderName} ] }
    currentChatUser: null,   // С кем открыт чат в данный момент
    ws: null,                // WebSocket соединение
    
    API_URL: "https://vault-inc.duckdns.org",
    WS_URL: "wss://vault-inc.duckdns.org/ws"
};

/**
 * МОДУЛЬ ШИФРОВАНИЯ (CRYPTO)
 */
const Crypto = {
    // Генерация новой пары ключей
    generateKeyPair() {
        return nacl.box.keyPair();
    },

    // Кодирование/Декодирование
    toBase64(bytes) { return nacl.util.encodeBase64(bytes); },
    fromBase64(str) { return nacl.util.decodeBase64(str); },
    toUTF8(bytes) { return nacl.util.encodeUTF8(bytes); },
    fromUTF8(str) { return nacl.util.decodeUTF8(str); },

    // Шифрование сообщения
    encrypt(text, targetPubKeyBase64, mySecretKey) {
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        const messageBytes = this.fromUTF8(text);
        const targetPubKey = this.fromBase64(targetPubKeyBase64);
        
        const encrypted = nacl.box(messageBytes, nonce, targetPubKey, mySecretKey);
        return {
            ciphertext: this.toBase64(encrypted),
            nonce: this.toBase64(nonce)
        };
    },

    // Расшифровка сообщения
    decrypt(ciphertextBase64, nonceBase64, fromPubKeyBase64, mySecretKey) {
        try {
            const ciphertext = this.fromBase64(ciphertextBase64);
            const nonce = this.fromBase64(nonceBase64);
            const fromPubKey = this.fromBase64(fromPubKeyBase64);

            const decrypted = nacl.box.open(ciphertext, nonce, fromPubKey, mySecretKey);
            return decrypted ? this.toUTF8(decrypted) : null;
        } catch (e) {
            console.error("Ошибка расшифровки:", e);
            return null;
        }
    }
};

/**
 * МОДУЛЬ СЕТЕВЫХ ЗАПРОСОВ (API)
 */
const API = {
    async request(path, method = 'GET', body = null) {
        const options = {
            method,
            headers: { 'Content-Type': 'application/json' }
        };
        if (body) options.body = JSON.stringify(body);
        
        const response = await fetch(`${State.API_URL}${path}`, options);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || "Ошибка сервера");
        }
        return response.json().catch(() => ({})); 
    },

    getUser(username) {
        return this.request(`/api/user?user=${encodeURIComponent(username)}`);
    },

    searchUserByKey(key) {
        return this.request(`/api/search?key=${encodeURIComponent(key)}`);
    },

    getContacts(username) {
        return this.request(`/api/contacts?user=${encodeURIComponent(username)}`);
    },

    getOfflineMessages(username) {
        return this.request(`/api/offline-messages?user=${encodeURIComponent(username)}`);
    }
};

/**
 * МОДУЛЬ ИНТЕРФЕЙСА (UI)
 */
const UI = {
    // Переключение экранов
    showScreen(screenId) {
        const screens = ['loginForm', 'registerForm', 'profileSetupForm', 'chatInterface'];
        screens.forEach(id => document.getElementById(id).classList.add('hidden'));
        document.getElementById(screenId).classList.remove('hidden');
    },

    // Отрисовка списка контактов
    renderContacts() {
        const list = document.getElementById('contactsList');
        list.innerHTML = '';
        
        Object.entries(State.contacts).forEach(([username, data]) => {
            const div = document.createElement('div');
            div.className = `contact-item ${State.currentChatUser === username ? 'active' : ''}`;
            
            const name = data.displayName || username;
            div.innerHTML = `
                <img src="${data.avatar || 'https://via.placeholder.com/40'}" class="contact-avatar">
                <div><strong>${name}</strong></div>
            `;
            div.onclick = () => Chat.selectContact(username);
            list.appendChild(div);
        });
    },

    // Отображение одного сообщения в окне чата
    displayMessage(text, type, senderName) {
        const messagesDiv = document.getElementById('messages');
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${type}`;
        
        if (type === 'received') {
            // Исправление: используем ник отправителя
            msgDiv.innerHTML = `<div class="msg-sender">${senderName}</div>${text}`;
        } else {
            msgDiv.innerText = text;
        }
        
        messagesDiv.appendChild(msgDiv);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    },

    // Очистка и полная перерисовка чата из истории
    refreshChatWindow() {
        const messagesDiv = document.getElementById('messages');
        messagesDiv.innerHTML = ''; // Очищаем старые сообщения
        
        if (State.currentChatUser && State.chatHistory[State.currentChatUser]) {
            State.chatHistory[State.currentChatUser].forEach(msg => {
                this.displayMessage(msg.text, msg.type, msg.senderName);
            });
        }
    }
};

/**
 * МОДУЛЬ ЛОГИКИ ЧАТА (CHAT)
 */
const Chat = {
    // Выбор контакта и загрузка истории
    async selectContact(username) {
        State.currentChatUser = username;
        const contact = State.contacts[username];
        const name = contact.displayName || username;

        // Обновляем шапку чата
        document.getElementById('currentChatUser').innerText = name;
        document.getElementById('chatHeaderAvatar').src = contact.avatar || 'https://via.placeholder.com/40';
        
        document.getElementById('emptyChatState').classList.add('hidden');
        document.getElementById('activeChatArea').classList.remove('hidden');

        // Перерисовываем список (для подсветки активного) и сообщения
        UI.renderContacts();
        UI.refreshChatWindow();

        if (window.innerWidth <= 768) {
            document.getElementById('sidebar').classList.add('mobile-hidden');
        }
    },

    // Сохранение сообщения в историю (чтобы не исчезали)
    saveToHistory(chatWith, text, type, senderName) {
        if (!State.chatHistory[chatWith]) {
            State.chatHistory[chatWith] = [];
        }
        State.chatHistory[chatWith].push({ text, type, senderName });
    },

    // Добавление нового контакта в локальное состояние
    async addNewContact(userObj, emitSocket = false) {
        const username = userObj.username;
        if (State.contacts[username]) return;

        State.contacts[username] = {
            publicKey: userObj.public_key || userObj.publicKey,
            avatar: userObj.avatar,
            displayName: userObj.nickname || userObj.displayName || username
        };

        UI.renderContacts();

        // Если это добавление через поиск, уведомляем другого пользователя
        if (emitSocket && State.ws) {
            State.ws.send(JSON.stringify({
                type: 'contact_added',
                from: State.myUsername,
                to: username,
                publicKey: Crypto.toBase64(State.myKeys.publicKey),
                avatar: State.myAvatarBase64
            }));
        }
    },

    // Обработка входящего пакета (сообщение или системное)
    async handleIncomingPacket(packet) {
        // 1. Если это уведомление о добавлении в контакты
        if (packet.type === 'contact_added') {
            await this.addNewContact({
                username: packet.from,
                public_key: packet.publicKey,
                avatar: packet.avatar
            });
            return;
        }

        // 2. Если это зашифрованное сообщение
        if (packet.ciphertext) {
            // Если отправителя нет в контактах, загружаем его данные (решает проблему первого сообщения)
            if (!State.contacts[packet.from]) {
                try {
                    const userData = await API.getUser(packet.from);
                    await this.addNewContact(userData);
                } catch (e) {
                    console.error("Не удалось получить данные отправителя", e);
                    return;
                }
            }

            const sender = State.contacts[packet.from];
            const decryptedText = Crypto.decrypt(
                packet.ciphertext,
                packet.nonce,
                sender.publicKey,
                State.myKeys.secretKey
            );

            if (decryptedText) {
                const senderName = sender.displayName || packet.from;
                // Сохраняем в историю
                this.saveToHistory(packet.from, decryptedText, 'received', senderName);
                
                // Если чат с ним открыт — отображаем сразу
                if (State.currentChatUser === packet.from) {
                    UI.displayMessage(decryptedText, 'received', senderName);
                } else {
                    customAlert(`Новое сообщение от ${senderName}`);
                }
            }
        }
    }
};

/**
 * МОДУЛЬ РАБОТЫ С WEBSOCKET
 */
function connectWebSocket() {
    if (State.ws) State.ws.close();

    State.ws = new WebSocket(`${State.WS_URL}?user=${State.myUsername}`);

    State.ws.onopen = () => console.log("Соединение установлено");
    
    State.ws.onmessage = (event) => {
        try {
            const packet = JSON.parse(event.data);
            Chat.handleIncomingPacket(packet);
        } catch (e) {
            console.error("Ошибка обработки сообщения", e);
        }
    };

    State.ws.onclose = () => {
        console.log("Соединение разорвано, переподключение...");
        setTimeout(connectWebSocket, 3000);
    };
}

/**
 * ФУНКЦИИ ВХОДА И РЕГИСТРАЦИИ (AUTH)
 */
async function register() {
    const username = document.getElementById('regUsername').value;
    const password = document.getElementById('regPassword').value;
    if (!username || !password) return customAlert("Заполните все поля");

    try {
        // Генерируем ключи сразу при регистрации
        const keys = Crypto.generateKeyPair();
        const pubKeyB64 = Crypto.toBase64(keys.publicKey);
        const privKeyB64 = Crypto.toBase64(keys.secretKey);

        const res = await API.request('/api/register', 'POST', {
            username: username,
            password: password,
            pubkey: pubKeyB64,
            avatar: "",
            nickname: ""
        });

        State.myUsername = username;
        State.myUniqueKey = res.unique_key;
        State.myKeys = keys;
        
        // Сохраняем приватный ключ в браузере
        localStorage.setItem(`privateKey_${username}`, privKeyB64);
        
        UI.showScreen('profileSetupForm');
    } catch (e) {
        customAlert("Ошибка регистрации: " + e.message);
    }
}

async function performLogin() {
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    if (!username || !password) return customAlert("Заполните поля");

    try {
        await API.request('/api/login', 'POST', { username, password });
        
        const userData = await API.getUser(username);
        
        State.myUsername = username;
        State.myNickname = userData.nickname || username;
        State.myUniqueKey = userData.unique_user_key;
        State.myAvatarBase64 = userData.avatar || "";

        // Восстановление ключей
        const savedPrivKeyB64 = localStorage.getItem(`privateKey_${username}`);
        if (!savedPrivKeyB64) {
            throw new Error("Приватный ключ не найден на этом устройстве.");
        }
        
        State.myKeys = {
            publicKey: Crypto.fromBase64(userData.public_key),
            secretKey: Crypto.fromBase64(savedPrivKeyB64)
        };

        // Инициализация интерфейса
        UI.showScreen('chatInterface');
        document.getElementById('displayUser').innerText = State.myNickname;
        document.getElementById('myUniqueKeyPreview').innerText = State.myUniqueKey.substring(0, 10) + "...";
        
        if (State.myAvatarBase64) {
            document.getElementById('myAvatarDisplay').src = State.myAvatarBase64;
            document.getElementById('myAvatarDisplay').style.display = 'flex';
            document.getElementById('myAvatarText').style.display = 'none';
        }

        // Загрузка данных
        const contacts = await API.getContacts(username);
        contacts.forEach(c => Chat.addNewContact(c));
        
        connectWebSocket();
        
        // Загрузка офлайн сообщений
        const offlineMsgs = await API.getOfflineMessages(username);
        for (const msg of offlineMsgs) {
            await Chat.handleIncomingPacket(msg);
        }

    } catch (e) {
        customAlert(e.message);
    }
}

async function completeProfileSetup() {
    const nickname = document.getElementById('setupNickname').value;
    if (!nickname) return customAlert("Введите ник");

    try {
        await API.request('/api/update-profile', 'POST', {
            username: State.myUsername,
            nickname: nickname,
            avatar: State.myAvatarBase64
        });
        
        State.myNickname = nickname;
        performLogin(); // Перезаходим для инициализации всего
    } catch (e) {
        customAlert(e.message);
    }
}

/**
 * ФУНКЦИИ ОТПРАВКИ И ПОИСКА
 */
function sendMessage() {
    const input = document.getElementById('msgText');
    const text = input.value.trim();
    if (!text || !State.currentChatUser) return;

    const target = State.contacts[State.currentChatUser];
    
    // Шифруем
    const encrypted = Crypto.encrypt(text, target.publicKey, State.myKeys.secretKey);

    const packet = {
        from: State.myUsername,
        to: State.currentChatUser,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce
    };

    if (State.ws && State.ws.readyState === WebSocket.OPEN) {
        State.ws.send(JSON.stringify(packet));
        
        // Сохраняем в историю и отображаем
        Chat.saveToHistory(State.currentChatUser, text, 'sent', State.myNickname);
        UI.displayMessage(text, 'sent', State.myNickname);
        
        input.value = '';
    } else {
        customAlert("Нет подключения к серверу");
    }
}

async function searchUser() {
    const key = document.getElementById('searchKey').value.trim();
    if (!key) return;

    try {
        const user = await API.searchUserByKey(key);
        const resultDiv = document.getElementById('searchResult');
        resultDiv.classList.remove('hidden');
        
        const name = user.nickname || user.username;
        resultDiv.innerHTML = `
            <div class="contact-item" id="foundUser">
                <img src="${user.avatar || 'https://via.placeholder.com/40'}" class="contact-avatar">
                <div>
                    <strong>${name}</strong><br>
                    <small>Нажмите, чтобы добавить</small>
                </div>
            </div>
        `;
        document.getElementById('foundUser').onclick = () => {
            Chat.addNewContact(user, true); // true = уведомить через сокет
            resultDiv.classList.add('hidden');
            document.getElementById('searchKey').value = '';
        };
    } catch (e) {
        customAlert("Пользователь не найден");
    }
}

/**
 * ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (ТЕМЫ, АВАТАРЫ)
 */
function processSetupAvatar(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            canvas.width = 64; canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, 64, 64);
            State.myAvatarBase64 = canvas.toDataURL('image/jpeg', 0.6);
        }
        img.src = e.target.result;
    }
    reader.readAsDataURL(file);
}

function toggleTheme() {
    const html = document.documentElement;
    const newTheme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    document.getElementById('themeIcon').className = newTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
}

// Загрузка темы при старте
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    if (document.getElementById('themeIcon')) {
        document.getElementById('themeIcon').className = savedTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    }
});

/**
 * ЭКСПОРТ ФУНКЦИЙ ДЛЯ HTML
 */
window.register = register;
window.performLogin = performLogin;
window.completeProfileSetup = completeProfileSetup;
window.showRegisterForm = () => UI.showScreen('registerForm');
window.showLoginForm = () => UI.showScreen('loginForm');
window.sendMessage = sendMessage;
window.searchUser = searchUser;
window.toggleTheme = toggleTheme;
window.processSetupAvatar = processSetupAvatar;
window.copyKey = () => { navigator.clipboard.writeText(State.myUniqueKey); customAlert("Ключ скопирован!"); };
window.showSidebar = () => document.getElementById('sidebar').classList.remove('mobile-hidden');
window.closeCustomAlert = () => document.getElementById('customAlert').classList.add('hidden');

function customAlert(msg) {
    document.getElementById('alertMessage').innerText = msg;
    document.getElementById('customAlert').classList.remove('hidden');
}