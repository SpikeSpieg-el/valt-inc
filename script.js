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
        
        console.log(`API Request: ${method} ${State.API_URL}${path}`);
        const response = await fetch(`${State.API_URL}${path}`, options);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        // ПРОВЕРКА: Если контента нет, не вызываем .json()
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            return response.json();
        }
        return {}; // Возвращаем пустой объект, если это не JSON
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

        // На мобильных скрываем сайдбар, чтобы показать чат
        if (window.innerWidth <= 768) {
            document.getElementById('sidebar').classList.add('mobile-hidden');
        }

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
        if (packet.type === 'profile_updated') {
            if (State.contacts[packet.username]) {
                State.contacts[packet.username].avatar = packet.avatar;
                State.contacts[packet.username].displayName = packet.nickname || packet.username;
                UI.renderContacts();
                if (State.currentChatUser === packet.username) {
                    document.getElementById('currentChatUser').innerText = packet.nickname || packet.username;
                    document.getElementById('chatHeaderAvatar').src = packet.avatar || 'https://via.placeholder.com/40';
                }
            }
            return;
        }

        if (packet.type === 'contact_added') {
            UI.addContactToUI(packet.from, packet.public_key, packet.avatar, packet.nickname);
            return;
        }

        // Если это сообщение
        if (packet.ciphertext) {
            const isMe = packet.from === State.myUsername;
            const chatPartner = isMe ? packet.to : packet.from;

            // Нам нужен публичный ключ партнера для расшифровки
            if (!State.contacts[chatPartner]) {
                const userData = await API.request(`/api/user?user=${chatPartner}`);
                if (userData) UI.addContactToUI(userData.username, userData.public_key, userData.avatar, userData.nickname);
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

    addContactToUI(username, pubkey, avatar, nickname = null) {
        if (username === State.myUsername) return;
        State.contacts[username] = { publicKey: pubkey, avatar: avatar, displayName: nickname || username };
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
        
        let contentHTML = "";

        // Проверяем, является ли сообщение файлом
        if (text.startsWith("FILE:")) {
            const fileInfo = text.replace("FILE:", "");
            const [fileName, fileData] = fileInfo.split("|");

            if (fileData.startsWith("data:image/")) {
                // Если это картинка — показываем превью
                contentHTML = `
                    <div class="file-msg">
                        <img src="${fileData}" class="chat-image" onclick="window.open('${fileData}')">
                        <br><small>${fileName}</small>
                    </div>`;
            } else {
                // Если другой файл — показываем ссылку на скачивание
                contentHTML = `
                    <div class="file-msg">
                        <i class="fas fa-file-download"></i>
                        <a href="${fileData}" download="${fileName}">${fileName}</a>
                    </div>`;
            }
        } else {
            // Обычный текст
            contentHTML = text;
        }

        msgDiv.innerHTML = type === 'received' ? `<div class="msg-sender">${senderName}</div>${contentHTML}` : contentHTML;
        
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
        State.myAvatarBase64 = userData.avatar || "";

        UI.showScreen('chatInterface');
        document.getElementById('displayUser').innerText = State.myNickname;
        
        // Обновляем аватар в сайдбаре
        if (State.myAvatarBase64) {
            document.getElementById('myAvatarDisplay').src = State.myAvatarBase64;
            document.getElementById('myAvatarDisplay').style.display = 'block';
            document.getElementById('myAvatarText').style.display = 'none';
        }

        // 1. Загружаем контакты
        const contacts = await API.request(`/api/contacts?user=${username}`);
        if (Array.isArray(contacts)) contacts.forEach(c => UI.addContactToUI(c.username, c.public_key, c.avatar, c.nickname));

        // 2. Загружаем историю сообщений с сервера
        try {
            const history = await API.request(`/api/history?user=${username}`);
            if (Array.isArray(history)) {
                for (const packet of history) {
                    await Chat.processPacket(packet);
                }
            }
        } catch (e) {
            console.log("Нет истории сообщений или ошибка загрузки:", e);
        }

        // 3. Подключаем WebSocket
        connectWebSocket();

        // 4. Загружаем офлайн-сообщения после подключения WS
        try {
            const offlineMsgs = await API.request(`/api/offline-messages?user=${username}`);
            if (Array.isArray(offlineMsgs)) {
                for (const packet of offlineMsgs) {
                    await Chat.processPacket(packet);
                }
            }
        } catch (e) {
            console.log("Нет офлайн-сообщений или ошибка загрузки:", e);
        }
    } catch (e) { customAlert("Ошибка входа"); }
}

function connectWebSocket() {
    State.ws = new WebSocket(`${State.WS_URL}?user=${State.myUsername}`);
    State.ws.onopen = () => console.log('WebSocket connected');
    State.ws.onmessage = (e) => Chat.processPacket(JSON.parse(e.data));
    State.ws.onclose = () => setTimeout(connectWebSocket, 3000);
}

function showSidebar() {
    document.getElementById('sidebar').classList.remove('mobile-hidden');
}

// Вынесем логику отправки в отдельную функцию, чтобы использовать её и для текста, и для файлов
function sendEncryptedMessage(content) {
    if (!State.currentChatUser) return;

    const target = State.contacts[State.currentChatUser];
    const encrypted = Crypto.encrypt(content, target.publicKey, State.myKeys.secretKey);

    const packet = {
        from: State.myUsername,
        to: State.currentChatUser,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce
    };

    if (!State.ws || State.ws.readyState === WebSocket.CLOSED) {
        customAlert("Нет подключения к серверу. Попробуйте позже.");
        return;
    }
    if (State.ws.readyState === WebSocket.CONNECTING) {
        State.ws.addEventListener('open', () => State.ws.send(JSON.stringify(packet)), { once: true });
    } else {
        State.ws.send(JSON.stringify(packet));
    }

    // Сохраняем в историю и отображаем
    Chat.saveToHistory(State.currentChatUser, content, 'sent', State.myNickname);
    UI.displayMessage(content, 'sent', State.myNickname);
}

function sendMessage() {
    const input = document.getElementById('msgText');
    const text = input.value.trim();
    if (!text) return;

    sendEncryptedMessage(text);
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
        console.log("Начало регистрации для пользователя:", username);
        const keys = nacl.box.keyPair();
        const pubKeyB64 = Crypto.toBase64(keys.publicKey);
        const privKeyB64 = Crypto.toBase64(keys.secretKey);

        // Шифруем приватный ключ паролем
        const encryptedPrivKey = await Crypto.encryptPrivateKey(privKeyB64, password);
        console.log("Ключи сгенерированы и зашифрованы");

        const res = await API.request('/api/register', 'POST', {
            username: username,
            password: password,
            pubkey: pubKeyB64,
            avatar: "",
            nickname: "",
            encrypted_private_key: encryptedPrivKey
        });
        console.log("Ответ сервера:", res);

        State.myUsername = username;
        State.myUniqueKey = res.unique_key;
        State.myKeys = keys;

        localStorage.setItem(`privateKey_${username}`, privKeyB64);

        UI.showScreen('profileSetupForm');
    } catch (e) {
        console.error("Ошибка регистрации:", e);
        customAlert("Ошибка регистрации: " + (e.message || "Неизвестная ошибка"));
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
        document.getElementById('foundUser').onclick = async () => {
            UI.addContactToUI(user.username, user.public_key, user.avatar, user.nickname);
            resultDiv.classList.add('hidden');
            document.getElementById('searchKey').value = '';
            
            // Сохраняем контакт на сервере
            try {
                await API.request('/api/add-contact', 'POST', {
                    user_username: State.myUsername,
                    contact_username: user.username,
                    contact_public_key: user.public_key,
                    contact_avatar: user.avatar
                });
            } catch (e) {
                console.log("Ошибка сохранения контакта на сервере:", e);
            }
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
            
            // Показываем превью
            const preview = document.getElementById('setupAvatarPreview');
            const container = document.getElementById('setupAvatarPreviewContainer');
            preview.src = State.myAvatarBase64;
            container.style.display = 'block';
        }
        img.src = e.target.result;
    }
    reader.readAsDataURL(file);
}

// Обработка прикрепления файла
async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Ограничение размера (например, 5МБ), так как Base64 увеличивает размер на 33%
    if (file.size > 5 * 1024 * 1024) {
        return customAlert("Файл слишком большой. Максимум 5МБ.");
    }

    const reader = new FileReader();
    reader.onload = async function(e) {
        const base64Data = e.target.result; // Это строка вида "data:image/png;base64,..."
        const fileName = file.name;
        
        // Формируем структуру: ИмяФайла|Тип|Данные
        const payload = `FILE:${fileName}|${base64Data}`;
        
        sendEncryptedMessage(payload);
    };
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

// Функции редактирования профиля
function openEditProfileModal() {
    document.getElementById('editNickname').value = State.myNickname;
    document.getElementById('editAvatarPreviewContainer').style.display = 'none';
    document.getElementById('editProfileModal').classList.remove('hidden');
}

function closeEditProfileModal() {
    document.getElementById('editProfileModal').classList.add('hidden');
    document.getElementById('editAvatarFile').value = '';
}

function processEditAvatar(event) {
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
            
            // Показываем превью
            const preview = document.getElementById('editAvatarPreview');
            const container = document.getElementById('editAvatarPreviewContainer');
            preview.src = State.myAvatarBase64;
            container.style.display = 'block';
        }
        img.src = e.target.result;
    }
    reader.readAsDataURL(file);
}

async function saveProfileChanges() {
    const nickname = document.getElementById('editNickname').value;
    if (!nickname) return customAlert("Введите ник");

    try {
        await API.request('/api/update-profile', 'POST', {
            username: State.myUsername,
            nickname: nickname,
            avatar: State.myAvatarBase64
        });
        
        State.myNickname = nickname;
        document.getElementById('displayUser').innerText = State.myNickname;
        
        // Обновляем аватар в сайдбаре
        if (State.myAvatarBase64) {
            document.getElementById('myAvatarDisplay').src = State.myAvatarBase64;
            document.getElementById('myAvatarDisplay').style.display = 'block';
            document.getElementById('myAvatarText').style.display = 'none';
        }
        
        closeEditProfileModal();
        customAlert("Профиль обновлен");
    } catch (e) {
        customAlert("Ошибка обновления профиля");
    }
}

// Экспорт дополнительных функций
window.register = register;
window.completeProfileSetup = completeProfileSetup;
window.searchUser = searchUser;
window.toggleTheme = toggleTheme;
window.processSetupAvatar = processSetupAvatar;
window.handleFileSelect = handleFileSelect;
window.openEditProfileModal = openEditProfileModal;
window.closeEditProfileModal = closeEditProfileModal;
window.processEditAvatar = processEditAvatar;
window.saveProfileChanges = saveProfileChanges;
window.showSidebar = showSidebar;