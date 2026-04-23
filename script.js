const API_URL = "https://vault-inc.duckdns.org";
const wsProtocol = "wss";
    
    let myKeys, myUsername, myUniqueKey, ws;
    let myNickname = "";
    let myAvatarBase64 = "";
    let contacts = {};
    let currentChatUser = null;
    let userPublicKeys = {};

    // --- Custom Alert ---
    function customAlert(message) {
        const alertModal = document.getElementById('customAlert');
        const alertMessage = document.getElementById('alertMessage');
        alertMessage.textContent = message;
        alertModal.classList.remove('hidden');
    }

    function closeCustomAlert() {
        const alertModal = document.getElementById('customAlert');
        alertModal.classList.add('hidden');
    }

    // --- Theme Toggle ---
    function toggleTheme() {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        
        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        
        const icon = document.getElementById('themeIcon');
        icon.className = newTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    }

    function loadTheme() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
        
        const icon = document.getElementById('themeIcon');
        if (icon) {
            icon.className = savedTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
        }
    }

    // Load theme on page load
    document.addEventListener('DOMContentLoaded', loadTheme);

    // --- UI Переключения ---
    function showRegisterForm() { document.getElementById('registerForm').classList.remove('hidden'); document.getElementById('loginForm').classList.add('hidden'); document.getElementById('profileSetupForm').classList.add('hidden'); }
    function showLoginForm() { document.getElementById('registerForm').classList.add('hidden'); document.getElementById('loginForm').classList.remove('hidden'); document.getElementById('profileSetupForm').classList.add('hidden'); }
    function showProfileSetupForm() { document.getElementById('registerForm').classList.add('hidden'); document.getElementById('profileSetupForm').classList.remove('hidden'); }
    
    function showChatInterface(avatarUrl) {
        document.getElementById('registerForm').classList.add('hidden');
        document.getElementById('loginForm').classList.add('hidden');
        document.getElementById('profileSetupForm').classList.add('hidden');
        document.getElementById('chatInterface').classList.remove('hidden');
        
        const displayName = myNickname || myUsername;
        document.getElementById('displayUser').innerText = displayName;
        document.getElementById('myUniqueKeyPreview').innerText = myUniqueKey.substring(0, 10) + "...";
        
        if (avatarUrl && avatarUrl.startsWith('data:image')) {
            document.getElementById('myAvatarText').style.display = 'none';
            document.getElementById('myAvatarDisplay').style.display = 'flex';
            document.getElementById('myAvatarDisplay').src = avatarUrl;
        } else {
            document.getElementById('myAvatarText').innerText = displayName.charAt(0).toUpperCase();
        }
    }

    function showSidebar() { document.getElementById('sidebar').classList.remove('mobile-hidden'); }
    function copyKey() { navigator.clipboard.writeText(myUniqueKey); customAlert("Ваш уникальный ключ скопирован!"); }

    // --- Обработка Аватара ---
    function processAvatar(event) {
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
                myAvatarBase64 = canvas.toDataURL('image/jpeg', 0.6);
            }
            img.src = e.target.result;
        }
        reader.readAsDataURL(file);
    }

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
                myAvatarBase64 = canvas.toDataURL('image/jpeg', 0.6);
            }
            img.src = e.target.result;
        }
        reader.readAsDataURL(file);
    }

    // --- Авторизация ---
    function register() {
        const username = document.getElementById('regUsername').value;
        const password = document.getElementById('regPassword').value;

        if (!username || !password) return customAlert("Введите логин и пароль");

        myKeys = nacl.box.keyPair();
        const pubKeyBase64 = nacl.util.encodeBase64(myKeys.publicKey);
        const secretKeyBase64 = nacl.util.encodeBase64(myKeys.secretKey);

        const data = {
            username: username,
            password: password,
            pubkey: pubKeyBase64,
            avatar: "",
            nickname: ""
        };

        fetch(`${API_URL}/api/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        })
            .then(res => res.json())
            .then(data => {
                myUniqueKey = data.unique_key;
                myUsername = username;
                localStorage.setItem(`privateKey_${username}`, secretKeyBase64);
                showProfileSetupForm();
            })
            .catch(err => customAlert("Ошибка регистрации: " + err));
    }

    function completeProfileSetup() {
        const nickname = document.getElementById('setupNickname').value;
        if (!nickname) return customAlert("Введите ник");

        myNickname = nickname;

        const data = {
            username: myUsername,
            nickname: myNickname,
            avatar: myAvatarBase64
        };

        fetch(`${API_URL}/api/update-profile`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        })
            .then(res => {
                if (!res.ok) throw new Error("Ошибка обновления профиля");
                return fetch(`${API_URL}/api/user?user=${encodeURIComponent(myUsername)}`);
            })
            .then(res => res.json())
            .then(data => {
                myUniqueKey = data.unique_user_key;
                userPublicKeys[myUsername] = data.public_key;
                
                const savedSecretKey = localStorage.getItem(`privateKey_${myUsername}`);
                if (savedSecretKey) {
                    const secretKeyBytes = nacl.util.decodeBase64(savedSecretKey);
                    const publicKeyBytes = nacl.util.decodeBase64(data.public_key);
                    myKeys = {
                        publicKey: publicKeyBytes,
                        secretKey: secretKeyBytes
                    };
                } else {
                    myKeys = nacl.box.keyPair();
                }
                
                showChatInterface(data.avatar);
                loadContacts();
                loadOfflineMessages();
                connectWebSocket();
            })
            .catch(err => customAlert(err.message));
    }

    function performLogin() {
        const username = document.getElementById('loginUsername').value;
        const password = document.getElementById('loginPassword').value;

        if (!username || !password) return customAlert("Введите логин и пароль");

        fetch(`${API_URL}/api/login?user=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, { method: 'POST' })
            .then(res => {
                if (!res.ok) throw new Error("Неверный логин или пароль");
                myUsername = username;
                return fetch(`${API_URL}/api/user?user=${encodeURIComponent(myUsername)}`);
            })
            .then(res => res.json())
            .then(data => {
                myUniqueKey = data.unique_user_key;
                myNickname = data.nickname || myUsername;
                userPublicKeys[myUsername] = data.public_key;
                
                const savedSecretKey = localStorage.getItem(`privateKey_${username}`);
                if (savedSecretKey) {
                    const secretKeyBytes = nacl.util.decodeBase64(savedSecretKey);
                    const publicKeyBytes = nacl.util.decodeBase64(data.public_key);
                    myKeys = {
                        publicKey: publicKeyBytes,
                        secretKey: secretKeyBytes
                    };
                } else {
                    myKeys = nacl.box.keyPair();
                }
                
                showChatInterface(data.avatar);
                loadContacts();
                loadOfflineMessages();
                connectWebSocket();
            })
            .catch(err => customAlert(err.message));
    }

    // --- Поиск и Контакты ---
    function searchUser() {
        const key = document.getElementById('searchKey').value;
        if (!key) return;

        fetch(`${API_URL}/api/search?key=${encodeURIComponent(key)}`)
            .then(res => { if(!res.ok) throw new Error(); return res.json(); })
            .then(data => {
                const resultDiv = document.getElementById('searchResult');
                resultDiv.classList.remove('hidden');
                const displayName = data.nickname || data.username;
                resultDiv.innerHTML = `
                    <div class="contact-item" onclick="addContact('${data.username}', '${data.public_key}', '${data.avatar || ''}', '${displayName}')">
                        <img src="${data.avatar || 'https://via.placeholder.com/40'}" class="contact-avatar" alt="avatar">
                        <div>
                            <strong>${displayName}</strong><br>
                            <small style="color:var(--text-muted)">Нажмите, чтобы добавить</small>
                        </div>
                    </div>
                `;
            })
            .catch(() => {
                customAlert("Пользователь не найден");
                document.getElementById('searchResult').classList.add('hidden');
            });
    }

    function addContact(username, publicKey, avatar, displayName) {
        if (contacts[username] || username === myUsername) return;
        contacts[username] = { publicKey, avatar, displayName };
        userPublicKeys[username] = publicKey;

        document.getElementById('searchResult').classList.add('hidden');
        document.getElementById('searchKey').value = '';
        renderContacts();

        // Сохраняем контакт в базу данных
        saveContactToDatabase(username, publicKey, avatar);

        // Отправляем уведомление добавленному пользователю
        sendContactAddedNotification(username);
    }

    function loadContacts() {
        fetch(`${API_URL}/api/contacts?user=${encodeURIComponent(myUsername)}`)
            .then(res => res.json())
            .then(data => {
                if (data && Array.isArray(data)) {
                    data.forEach(contact => {
                        contacts[contact.username] = { publicKey: contact.public_key, avatar: contact.avatar };
                        userPublicKeys[contact.username] = contact.public_key;
                    });
                }
                renderContacts();
            })
            .catch(err => console.error("Error loading contacts:", err));
    }

    function loadOfflineMessages() {
        fetch(`${API_URL}/api/offline-messages?user=${encodeURIComponent(myUsername)}`)
            .then(res => res.json())
            .then(messages => {
                if (messages && Array.isArray(messages)) {
                    messages.forEach(msg => {
                        const packet = {
                            from: msg.from,
                            ciphertext: msg.ciphertext,
                            nonce: msg.nonce
                        };
                        decryptAndDisplay(packet);
                    });
                }
            })
            .catch(err => console.error("Error loading offline messages:", err));
    }

    function saveContactToDatabase(username, publicKey, avatar) {
        const data = {
            user_username: myUsername,
            contact_username: username,
            contact_public_key: publicKey,
            contact_avatar: avatar
        };

        fetch(`${API_URL}/api/add-contact`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        }).catch(err => console.error("Error saving contact:", err));
    }

    function sendContactAddedNotification(targetUsername) {
        if(ws && ws.readyState === WebSocket.OPEN) {
            const notification = {
                type: 'contact_added',
                from: myUsername,
                to: targetUsername,
                publicKey: nacl.util.encodeBase64(myKeys.publicKey),
                avatar: myAvatarBase64
            };
            ws.send('42' + JSON.stringify(['notification', notification]));
        }
    }

    function renderContacts() {
        const list = document.getElementById('contactsList');
        list.innerHTML = '';
        
        for (const [username, data] of Object.entries(contacts)) {
            const div = document.createElement('div');
            div.className = 'contact-item' + (currentChatUser === username ? ' active' : '');
            const displayName = data.displayName || username;
            div.innerHTML = `
                <img src="${data.avatar || 'https://via.placeholder.com/40'}" class="contact-avatar" alt="avatar">
                <div><strong>${displayName}</strong></div>
            `;
            div.onclick = () => selectContact(username, displayName);
            list.appendChild(div);
        }
    }

    function selectContact(username, displayName) {
        currentChatUser = username;
        const name = displayName || username;
        document.getElementById('currentChatUser').innerText = name;
        document.getElementById('chatHeaderAvatar').src = contacts[username]?.avatar || 'https://via.placeholder.com/40';
        
        document.getElementById('emptyChatState').classList.add('hidden');
        document.getElementById('activeChatArea').classList.remove('hidden');
        document.getElementById('messages').innerHTML = ''; 
        
        if(window.innerWidth <= 768) {
            document.getElementById('sidebar').classList.add('mobile-hidden');
        }
    }

    // --- WebSockets и Шифрование ---
    function connectWebSocket() {
        ws = new WebSocket(`${wsProtocol}://vault-inc.duckdns.org/socket.io/?user=${myUsername}`);
        
        ws.onopen = () => {
            console.log("WebSocket connected");
        };
        
        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
        };
        
        ws.onclose = () => {
            console.log("WebSocket disconnected");
        };
        
        ws.onmessage = (event) => {
            // Игнорируем пинги/понги Socket.io (начинаются с цифр)
            if(event.data.startsWith('0') || event.data.startsWith('40')) return;

            try {
                // Если socket.io шлет сообщения в формате: 42["message", {...}]
                let msgData = event.data;
                let eventType = '';
                if(msgData.startsWith('42')) {
                    const parsed = JSON.parse(msgData.substring(2));
                    eventType = parsed[0];
                    msgData = parsed[1];
                } else {
                    msgData = JSON.parse(msgData);
                }

                if (msgData && msgData.type === 'contact_added') {
                    // Обрабатываем уведомление о добавлении в контакты
                    handleContactAddedNotification(msgData);
                } else if (msgData && msgData.ciphertext) {
                    decryptAndDisplay(msgData);
                }
            } catch(e) { console.log("Неизвестный формат сообщения", e); }
        };
    }

    function handleContactAddedNotification(notification) {
        const senderUsername = notification.from;
        const senderPublicKey = notification.publicKey;
        const senderAvatar = notification.avatar;

        if (contacts[senderUsername] || senderUsername === myUsername) return;
        contacts[senderUsername] = { publicKey: senderPublicKey, avatar: senderAvatar };
        userPublicKeys[senderUsername] = senderPublicKey;

        renderContacts();
    }

    function sendMessage() {
        if (!currentChatUser) return;
        const text = document.getElementById('msgText').value;
        if (!text) return;

        const toPubKeyBase64 = userPublicKeys[currentChatUser];
        const toPubKey = nacl.util.decodeBase64(toPubKeyBase64);
        const msgBytes = nacl.util.decodeUTF8(text);
        
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        const encrypted = nacl.box(msgBytes, nonce, toPubKey, myKeys.secretKey);

        const packet = {
            from: myUsername,
            to: currentChatUser,
            ciphertext: nacl.util.encodeBase64(encrypted),
            nonce: nacl.util.encodeBase64(nonce)
        };

        // Отправка в формате Socket.io
        if(ws && ws.readyState === WebSocket.OPEN) {
            ws.send('42' + JSON.stringify(['message', packet]));
            displayMessage(text, 'sent');
            document.getElementById('msgText').value = '';
        } else {
            customAlert("Нет подключения к серверу");
        }
    }

    function decryptAndDisplay(packet) {
        if (packet.from === myUsername) return; // Игнорируем свои же эхо-сообщения

        const fromPubKeyBase64 = userPublicKeys[packet.from];
        if (!fromPubKeyBase64) {
            fetch(`${API_URL}/api/user?user=${encodeURIComponent(packet.from)}`)
                .then(res => res.json())
                .then(data => {
                    userPublicKeys[packet.from] = data.public_key;
                    addContact(packet.from, data.public_key, data.avatar);
                    attemptDecrypt(packet, data.public_key);
                });
            return;
        }
        attemptDecrypt(packet, fromPubKeyBase64);
    }

    function attemptDecrypt(packet, fromPubKeyBase64) {
        const fromPubKey = nacl.util.decodeBase64(fromPubKeyBase64);
        const ciphertext = nacl.util.decodeBase64(packet.ciphertext);
        const nonce = nacl.util.decodeBase64(packet.nonce);

        const decryptedBytes = nacl.box.open(ciphertext, nonce, fromPubKey, myKeys.secretKey);
        
        if (decryptedBytes) {
            const text = nacl.util.encodeUTF8(decryptedBytes);
            
            // Если сообщение пришло от текущего открытого чата, выводим его
            if (currentChatUser === packet.from) {
                displayMessage(text, 'received', packet.from);
            } else {
                // Если чат не открыт, просто показываем уведомление или добавляем контакт (он уже добавлен выше)
                customAlert(`Новое сообщение от ${packet.from}`);
            }
        }
    }

    function displayMessage(text, type, sender = null) {
        const messagesDiv = document.getElementById('messages');
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${type}`;
        
        if (sender && type === 'received') {
            msgDiv.innerHTML = `<div class="msg-sender">${sender}</div>${text}`;
        } else {
            msgDiv.innerText = text;
        }
        
        messagesDiv.appendChild(msgDiv);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }