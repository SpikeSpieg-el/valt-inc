/**
 * ГЛОБАЛЬНОЕ СОСТОЯНИЕ (STATE)
 */
const State = {
    myKeys: null,
    myUsername: "",
    myNickname: "",
    myUniqueKey: "",
    myAvatarBase64: "",
    contacts: {},
    chatHistory: {}, // Теперь загружается с сервера
    currentChatUser: null,
    ws: null,
    
    API_URL: "https://vault-inc.duckdns.org",
    WS_URL: "wss://vault-inc.duckdns.org/ws"
};

/**
 * КРИПТОГРАФИЯ (CRYPTO)
 */
const Crypto = {
    toBase64(bytes) { return nacl.util.encodeBase64(bytes); },
    fromBase64(str) { return nacl.util.decodeBase64(str); },
    toUTF8(bytes) { return nacl.util.encodeUTF8(bytes); },
    fromUTF8(str) { return nacl.util.decodeUTF8(str); },

    // Шифрование приватного ключа паролем (для хранения на сервере)
    async encryptPrivateKey(privateKeyBase64, password) {
        const pwHash = Array.from(password).reduce((s, c) => s + c.charCodeAt(0), 0).toString();
        const key = new Uint8Array(32);
        const pwBytes = nacl.util.decodeUTF8(password.padEnd(32, '0').substring(0, 32));
        key.set(pwBytes);
        
        const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
        const encrypted = nacl.secretbox(this.fromBase64(privateKeyBase64), nonce, key);
        
        return this.toBase64(nonce) + ":" + this.toBase64(encrypted);
    },

    async decryptPrivateKey(encryptedData, password) {
        try {
            const [nonceB64, cipherB64] = encryptedData.split(":");
            const key = new Uint8Array(32);
            const pwBytes = nacl.util.decodeUTF8(password.padEnd(32, '0').substring(0, 32));
            key.set(pwBytes);
            
            const decrypted = nacl.secretbox.open(this.fromBase64(cipherB64), this.fromBase64(nonceB64), key);
            return decrypted ? this.toBase64(decrypted) : null;
        } catch (e) { return null; }
    },

    encrypt(text, targetPubKeyBase64, mySecretKey) {
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        const encrypted = nacl.box(this.fromUTF8(text), nonce, this.fromBase64(targetPubKeyBase64), mySecretKey);
        return { ciphertext: this.toBase64(encrypted), nonce: this.toBase64(nonce) };
    },

    decrypt(ciphertextBase64, nonceBase64, fromPubKeyBase64, mySecretKey) {
        try {
            const res = nacl.box.open(this.fromBase64(ciphertextBase64), this.fromBase64(nonceBase64), this.fromBase64(fromPubKeyBase64), mySecretKey);
            return res ? this.toUTF8(res) : null;
        } catch (e) { return null; }
    }
};

/**
 * СЕТЬ (API)
 */
const API = {
    async request(path, method = 'GET', body = null) {
        const options = { method, headers: { 'Content-Type': 'application/json' } };
        if (body) options.body = JSON.stringify(body);
        const response = await fetch(`${State.API_URL}${path}`, options);
        return response.ok ? response.json() : [];
    }
};

/**
 * ЛОГИКА ЧАТА (CHAT)
 */
const Chat = {
    async selectContact(username) {
        State.currentChatUser = username;
        const contact = State.contacts[username];
        
        document.getElementById('currentChatUser').innerText = contact.displayName || username;
        document.getElementById('chatHeaderAvatar').src = contact.avatar || 'https://via.placeholder.com/40';
        document.getElementById('emptyChatState').classList.add('hidden');
        document.getElementById('activeChatArea').classList.remove('hidden');

        UI.renderContacts();
        UI.refreshChatWindow();
    },

    saveToHistory(chatWith, text, type, senderName) {
        if (!State.chatHistory[chatWith]) State.chatHistory[chatWith] = [];
        // Проверка на дубликаты (чтобы не дублировать историю при загрузке)
        const isDuplicate = State.chatHistory[chatWith].some(m => m.text === text && m.type === type);
        if (!isDuplicate) {
            State.chatHistory[chatWith].push({ text, type, senderName });
        }
    },

    async processPacket(packet) {
        if (packet.type === 'contact_added') {
            UI.addContactToUI(packet.from, packet.publicKey, packet.avatar);
            return;
        }

        // Если это сообщение
        if (packet.ciphertext) {
            const isMe = packet.from === State.myUsername;
            const chatPartner = isMe ? packet.to : packet.from;

            // Нам нужен публичный ключ партнера для расшифровки
            if (!State.contacts[chatPartner]) {
                const userData = await API.request(`/api/user?user=${chatPartner}`);
                if (userData) UI.addContactToUI(userData.username, userData.public_key, userData.avatar);
            }

            const partner = State.contacts[chatPartner];
            if (!partner) return;

            const decrypted = Crypto.decrypt(packet.ciphertext, packet.nonce, partner.publicKey, State.myKeys.secretKey);
            
            if (decrypted) {
                const type = isMe ? 'sent' : 'received';
                const senderName = isMe ? State.myNickname : (partner.displayName || chatPartner);
                
                this.saveToHistory(chatPartner, decrypted, type, senderName);
                
                if (State.currentChatUser === chatPartner) {
                    UI.displayMessage(decrypted, type, senderName);
                }
            }
        }
    }
};

/**
 * ИНТЕРФЕЙС (UI)
 */
const UI = {
    showScreen(id) {
        ['loginForm', 'registerForm', 'profileSetupForm', 'chatInterface'].forEach(s => document.getElementById(s).classList.add('hidden'));
        document.getElementById(id).classList.remove('hidden');
    },

    addContactToUI(username, pubkey, avatar) {
        if (username === State.myUsername) return;
        State.contacts[username] = { publicKey: pubkey, avatar: avatar, displayName: username };
        this.renderContacts();
    },

    renderContacts() {
        const list = document.getElementById('contactsList');
        list.innerHTML = '';
        Object.entries(State.contacts).forEach(([username, data]) => {
            const div = document.createElement('div');
            div.className = `contact-item ${State.currentChatUser === username ? 'active' : ''}`;
            div.innerHTML = `<img src="${data.avatar || 'https://via.placeholder.com/40'}" class="contact-avatar"><div><strong>${data.displayName || username}</strong></div>`;
            div.onclick = () => Chat.selectContact(username);
            list.appendChild(div);
        });
    },

    displayMessage(text, type, senderName) {
        const messagesDiv = document.getElementById('messages');
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${type}`;
        msgDiv.innerHTML = type === 'received' ? `<div class="msg-sender">${senderName}</div>${text}` : text;
        messagesDiv.appendChild(msgDiv);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    },

    refreshChatWindow() {
        document.getElementById('messages').innerHTML = '';
        if (State.currentChatUser && State.chatHistory[State.currentChatUser]) {
            State.chatHistory[State.currentChatUser].forEach(m => this.displayMessage(m.text, m.type, m.senderName));
        }
    }
};

/**
 * АВТОРИЗАЦИЯ И ЗАГРУЗКА
 */
async function performLogin() {
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;

    try {
        await API.request('/api/login', 'POST', { username, password });
        const userData = await API.request(`/api/user?user=${username}`);
        
        State.myUsername = username;
        State.myNickname = userData.nickname || username;
        State.myUniqueKey = userData.unique_user_key;
        
        let privKeyB64 = localStorage.getItem(`privateKey_${username}`);
        
        // Пытаемся восстановить ключ с сервера, если его нет локально
        if (!privKeyB64 && userData.encrypted_private_key) {
            console.log("Восстановление ключа с сервера...");
            privKeyB64 = await Crypto.decryptPrivateKey(userData.encrypted_private_key, password);
            if (privKeyB64) {
                localStorage.setItem(`privateKey_${username}`, privKeyB64);
            }
        }

        if (!privKeyB64) {
            customAlert("Ошибка: Не удалось расшифровать ключ или он отсутствует.");
            return;
        }

        State.myKeys = { publicKey: Crypto.fromBase64(userData.public_key), secretKey: Crypto.fromBase64(privKeyB64) };

        UI.showScreen('chatInterface');
        document.getElementById('displayUser').innerText = State.myNickname;

        // 1. Загружаем контакты
        const contacts = await API.request(`/api/contacts?user=${username}`);
        if (Array.isArray(contacts)) contacts.forEach(c => UI.addContactToUI(c.username, c.public_key, c.avatar));

        // 2. Загружаем историю сообщений с сервера
        const history = await API.request(`/api/history?user=${username}`);
        if (Array.isArray(history)) {
            for (const packet of history) {
                await Chat.processPacket(packet);
            }
        }

        connectWebSocket();
    } catch (e) { customAlert("Ошибка входа"); }
}

function connectWebSocket() {
    State.ws = new WebSocket(`${State.WS_URL}?user=${State.myUsername}`);
    State.ws.onmessage = (e) => Chat.processPacket(JSON.parse(e.data));
    State.ws.onclose = () => setTimeout(connectWebSocket, 3000);
}

function sendMessage() {
    const input = document.getElementById('msgText');
    const text = input.value.trim();
    if (!text || !State.currentChatUser) return;

    const target = State.contacts[State.currentChatUser];
    const encrypted = Crypto.encrypt(text, target.publicKey, State.myKeys.secretKey);

    const packet = { from: State.myUsername, to: State.currentChatUser, ciphertext: encrypted.ciphertext, nonce: encrypted.nonce };
    State.ws.send(JSON.stringify(packet));
    
    Chat.saveToHistory(State.currentChatUser, text, 'sent', State.myNickname);
    UI.displayMessage(text, 'sent', State.myNickname);
    input.value = '';
}

// Привязка к кнопкам (остальное как в прошлом примере)
window.performLogin = performLogin;
window.sendMessage = sendMessage;
window.copyKey = () => { navigator.clipboard.writeText(State.myUniqueKey); customAlert("Скопировано"); };
window.showRegisterForm = () => UI.showScreen('registerForm');
window.showLoginForm = () => UI.showScreen('loginForm');
window.closeCustomAlert = () => document.getElementById('customAlert').classList.add('hidden');
function customAlert(m) { document.getElementById('alertMessage').innerText = m; document.getElementById('customAlert').classList.remove('hidden'); }

// Регистрация
async function register() {
    const username = document.getElementById('regUsername').value;
    const password = document.getElementById('regPassword').value;
    if (!username || !password) return customAlert("Заполните все поля");

    try {
        const keys = nacl.box.keyPair();
        const pubKeyB64 = Crypto.toBase64(keys.publicKey);
        const privKeyB64 = Crypto.toBase64(keys.secretKey);

        // Шифруем приватный ключ паролем
        const encryptedPrivKey = await Crypto.encryptPrivateKey(privKeyB64, password);

        const res = await API.request('/api/register', 'POST', {
            username: username,
            password: password,
            pubkey: pubKeyB64,
            avatar: "",
            nickname: "",
            encrypted_private_key: encryptedPrivKey
        });

        State.myUsername = username;
        State.myUniqueKey = res.unique_key;
        State.myKeys = keys;
        
        localStorage.setItem(`privateKey_${username}`, privKeyB64);
        
        UI.showScreen('profileSetupForm');
    } catch (e) {
        customAlert("Ошибка регистрации");
    }
}

// Настройка профиля
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
        performLogin();
    } catch (e) {
        customAlert("Ошибка");
    }
}

// Поиск пользователя
async function searchUser() {
    const key = document.getElementById('searchKey').value.trim();
    if (!key) return;

    try {
        const user = await API.request(`/api/search?key=${key}`);
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
            UI.addContactToUI(user.username, user.public_key, user.avatar);
            resultDiv.classList.add('hidden');
            document.getElementById('searchKey').value = '';
        };
    } catch (e) {
        customAlert("Пользователь не найден");
    }
}

// Обработка аватара
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

// Переключение темы
function toggleTheme() {
    const html = document.documentElement;
    const newTheme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    const icon = document.getElementById('themeIcon');
    if (icon) icon.className = newTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
}

// Загрузка темы при старте
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    const icon = document.getElementById('themeIcon');
    if (icon) icon.className = savedTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
});

// Экспорт дополнительных функций
window.register = register;
window.completeProfileSetup = completeProfileSetup;
window.searchUser = searchUser;
window.toggleTheme = toggleTheme;
window.processSetupAvatar = processSetupAvatar;