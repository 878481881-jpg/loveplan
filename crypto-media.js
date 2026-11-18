/**
 * LovePlan 端到端媒体隐私加密与防窥引擎 (crypto-media.js)
 * 核心能力：
 * 1. 看不出是图片 (.dat 伪装) + 点开全是乱码 (LPENCv02 / LPENCv01)：
 *    - 所有图片（.jpg/.jpeg/.png/.heic）与音频（.m4a/.wav/.webm）统一采用 RC4-Drop1024 流式加密 + 混淆乱码字符编码（LPENCv02 / LPENCv01）。
 *    - 文件名后缀全面伪装为 .dat（例如 origin_1789048480651.dat），外人进入 GitHub 仓库既看不出任何图片后缀，直接点开文件也只会看到满屏乱码字符，下载到本地改后缀也无法打开。
 * 2. HTML 页面内无感正常打开：
 *    - 自动拦截 HTMLImageElement.src / HTMLMediaElement.src 与 DOM MutationObserver。
 *    - 拉取加密的 .dat / 乱码文件后，在浏览器内存中毫秒级解密还原，并通过文件头魔数（Magic Bytes）自动识别真实格式（JPEG/PNG/GIF/WEBP/HEIC/MP4/M4A/WAV/WEBM），生成临时 Blob URL 供页面正常渲染。
 * 3. 一键将 GitHub 云端现有图片变成 .dat 乱码文件：
 *    - 页面右下角自动挂载「🔐 图片乱码盾」快捷按钮，点击即可一键将 GitHub 仓库里现有的所有明文图片加密为 .dat 乱码文件、删除旧明文图片并自动更新 JSON 索引。
 */
(function (window) {
    'use strict';

    const MAGIC_V1 = [0x4C, 0x50, 0x45, 0x4E, 0x43, 0x76, 0x30, 0x31]; // "LPENCv01" (二进制加密流)
    const MAGIC_V2 = [0x4C, 0x50, 0x45, 0x4E, 0x43, 0x76, 0x30, 0x32]; // "LPENCv02" (可见乱码文本流)
    const OWNER_REPO = '878481881-jpg/loveplan';
    const VAULT_SECRET = 'LovePlanVault_878481881_HengQin_2026_SecretKey!';
    const MEDIA_FOLDERS = ['photowall/', 'travel/', 'firsttimes/', 'picture/', 'voice/'];
    const KS_LEN = 65536; // 64KB per-file derived keystream block

    const blobUrlCache = new Map();
    const inflightPromises = new Map();

    // 1x1 透明占位 GIF，避免加密文件被浏览器当作损坏图片闪烁报错
    const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    const SECRET_BYTES = new TextEncoder().encode(VAULT_SECRET);

    const imgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    const mediaSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    const origSetAttribute = Element.prototype.setAttribute;
    const origFetch = window.fetch;

    function hasMagicV1(bytes) {
        if (!bytes || bytes.length < 16) return false;
        for (let i = 0; i < 8; i++) {
            if (bytes[i] !== MAGIC_V1[i]) return false;
        }
        return true;
    }

    function hasMagicV2(bytes) {
        if (!bytes || bytes.length < 16) return false;
        for (let i = 0; i < 8; i++) {
            if (bytes[i] !== MAGIC_V2[i]) return false;
        }
        return true;
    }

    function hasMagicHeader(bytes) {
        return hasMagicV1(bytes) || hasMagicV2(bytes);
    }

    function initRc4State(nonce8Bytes) {
        const keyLen = SECRET_BYTES.length + 8;
        const keyWithNonce = new Uint8Array(keyLen);
        keyWithNonce.set(SECRET_BYTES, 0);
        keyWithNonce.set(nonce8Bytes, SECRET_BYTES.length);

        const S = new Uint8Array(256);
        for (let i = 0; i < 256; i++) S[i] = i;

        let j = 0;
        for (let i = 0; i < 256; i++) {
            j = (j + S[i] + keyWithNonce[i % keyLen]) & 0xFF;
            const tmp = S[i]; S[i] = S[j]; S[j] = tmp;
        }

        let i = 0;
        j = 0;
        for (let d = 0; d < 1024; d++) {
            i = (i + 1) & 0xFF;
            j = (j + S[i]) & 0xFF;
            const tmp = S[i]; S[i] = S[j]; S[j] = tmp;
        }
        return { S, i, j };
    }

    function cipherTransform64K(payloadBytes, nonce8Bytes) {
        const state = initRc4State(nonce8Bytes);
        const S = state.S;
        let i = state.i, j = state.j;

        const ksSize = Math.min(payloadBytes.length, KS_LEN);
        const ks = new Uint8Array(ksSize);
        for (let k = 0; k < ksSize; k++) {
            i = (i + 1) & 0xFF;
            j = (j + S[i]) & 0xFF;
            const tmp = S[i]; S[i] = S[j]; S[j] = tmp;
            ks[k] = S[(S[i] + S[j]) & 0xFF];
        }

        const out = new Uint8Array(payloadBytes.length);
        for (let k = 0; k < payloadBytes.length; k++) {
            out[k] = payloadBytes[k] ^ ks[k & 0xFFFF];
        }
        return out;
    }

    function cipherTransformFull(payloadBytes, nonce8Bytes) {
        const state = initRc4State(nonce8Bytes);
        const S = state.S;
        let i = state.i, j = state.j;
        const len = payloadBytes.length;
        const out = new Uint8Array(len);
        for (let k = 0; k < len; k++) {
            i = (i + 1) & 0xFF;
            j = (j + S[i]) & 0xFF;
            const tmp = S[i]; S[i] = S[j]; S[j] = tmp;
            out[k] = payloadBytes[k] ^ S[(S[i] + S[j]) & 0xFF];
        }
        return out;
    }

    function base64ToUint8Array(b64) {
        const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
        const binStr = window.atob(clean);
        const len = binStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binStr.charCodeAt(i);
        }
        return bytes;
    }

    function uint8ArrayToBase64(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const sub = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, sub);
        }
        return window.btoa(binary);
    }

    function encryptBytesV1(plainBytes) {
        if (hasMagicHeader(plainBytes)) return plainBytes;
        const nonce = new Uint8Array(8);
        if (window.crypto && window.crypto.getRandomValues) {
            window.crypto.getRandomValues(nonce);
        } else {
            for (let i = 0; i < 8; i++) nonce[i] = Math.floor(Math.random() * 256);
        }
        const encryptedPayload = cipherTransform64K(plainBytes, nonce);
        const result = new Uint8Array(16 + encryptedPayload.length);
        result.set(MAGIC_V1, 0);
        result.set(nonce, 8);
        result.set(encryptedPayload, 16);
        return result;
    }

    /**
     * 将原始字节加密为 LPENCv02 可见乱码文本字节流（在 GitHub 网页点开直接显示满屏乱码符号，且不可被还原为图片）
     */
    function encryptBytes(plainBytes) {
        if (hasMagicV2(plainBytes)) return plainBytes;
        const v1Bytes = hasMagicV1(plainBytes) ? plainBytes : encryptBytesV1(plainBytes);
        const rawB64 = uint8ArrayToBase64(v1Bytes);
        const reversed = rawB64.split('').reverse().join('');
        const lines = ['LPENCv02~#$!@^&*()[ENCRYPTED_GARBLED_STREAM_DO_NOT_EDIT]~#$!@^&*()'];
        for (let i = 0; i < reversed.length; i += 72) {
            lines.push('§¤÷×±≈≠≡≤≥' + reversed.slice(i, i + 72) + '¶†‡•‰′″');
        }
        return new TextEncoder().encode(lines.join('\n'));
    }

    function decryptBytesV1(inputBytes) {
        if (!hasMagicV1(inputBytes)) return inputBytes;
        const nonce = inputBytes.subarray(8, 16);
        const ciphertext = inputBytes.subarray(16);
        const out64K = cipherTransform64K(ciphertext, nonce);
        if (ciphertext.length <= KS_LEN) return out64K;

        const len = out64K.length;
        if (out64K[0] === 0xFF && out64K[1] === 0xD8) {
            if (out64K[len - 2] === 0xFF && out64K[len - 1] === 0xD9) return out64K;
            const outFull = cipherTransformFull(ciphertext, nonce);
            if (outFull[len - 2] === 0xFF && outFull[len - 1] === 0xD9) return outFull;
            return out64K;
        }
        if (out64K[0] === 0x89 && out64K[1] === 0x50 && out64K[2] === 0x4E && out64K[3] === 0x47) {
            if (out64K[len - 4] === 0xAE && out64K[len - 3] === 0x42 && out64K[len - 2] === 0x60 && out64K[len - 1] === 0x82) return out64K;
            const outFull = cipherTransformFull(ciphertext, nonce);
            if (outFull[len - 4] === 0xAE && outFull[len - 3] === 0x42 && outFull[len - 2] === 0x60 && outFull[len - 1] === 0x82) return outFull;
            return out64K;
        }
        return out64K;
    }

    function decryptBytes(inputBytes) {
        if (!inputBytes || inputBytes.length < 16) return inputBytes;
        if (hasMagicV2(inputBytes)) {
            const text = new TextDecoder().decode(inputBytes);
            const firstNewline = text.indexOf('\n');
            const body = firstNewline !== -1 ? text.slice(firstNewline + 1) : text.slice(8);
            const cleanReversed = body.replace(/[^A-Za-z0-9+/=]/g, '');
            const origB64 = cleanReversed.split('').reverse().join('');
            const v1Bytes = base64ToUint8Array(origB64);
            return decryptBytesV1(v1Bytes);
        }
        if (hasMagicV1(inputBytes)) {
            return decryptBytesV1(inputBytes);
        }
        return inputBytes;
    }

    function encryptBase64(plainBase64) {
        if (!plainBase64) return plainBase64;
        const rawB64 = plainBase64.includes(',') ? plainBase64.split(',')[1] : plainBase64;
        const plainBytes = base64ToUint8Array(rawB64);
        const encBytes = encryptBytes(plainBytes);
        return uint8ArrayToBase64(encBytes);
    }

    /**
     * 通过解密后的真实文件头魔数（Magic Bytes）识别 MIME 类型，即使文件名后缀是 .dat 也能 100% 还原
     */
    function detectMimeType(decryptedBytes, fallbackUrl) {
        if (decryptedBytes && decryptedBytes.length >= 12) {
            if (decryptedBytes[0] === 0xFF && decryptedBytes[1] === 0xD8 && decryptedBytes[2] === 0xFF) {
                return 'image/jpeg';
            }
            if (decryptedBytes[0] === 0x89 && decryptedBytes[1] === 0x50 && decryptedBytes[2] === 0x4E && decryptedBytes[3] === 0x47) {
                return 'image/png';
            }
            if (decryptedBytes[0] === 0x47 && decryptedBytes[1] === 0x49 && decryptedBytes[2] === 0x46 && decryptedBytes[3] === 0x38) {
                return 'image/gif';
            }
            if (decryptedBytes[0] === 0x52 && decryptedBytes[1] === 0x49 && decryptedBytes[2] === 0x46 && decryptedBytes[3] === 0x46) {
                if (decryptedBytes[8] === 0x57 && decryptedBytes[9] === 0x45 && decryptedBytes[10] === 0x42 && decryptedBytes[11] === 0x50) {
                    return 'image/webp';
                }
                if (decryptedBytes[8] === 0x57 && decryptedBytes[9] === 0x41 && decryptedBytes[10] === 0x56 && decryptedBytes[11] === 0x45) {
                    return 'audio/wav';
                }
            }
            if (decryptedBytes[0] === 0x1A && decryptedBytes[1] === 0x45 && decryptedBytes[2] === 0xDF && decryptedBytes[3] === 0xA3) {
                return 'audio/webm';
            }
            if (decryptedBytes[0] === 0x4F && decryptedBytes[1] === 0x67 && decryptedBytes[2] === 0x67 && decryptedBytes[3] === 0x53) {
                return 'audio/ogg';
            }
            if (decryptedBytes[4] === 0x66 && decryptedBytes[5] === 0x74 && decryptedBytes[6] === 0x79 && decryptedBytes[7] === 0x70) {
                const brand = String.fromCharCode(decryptedBytes[8], decryptedBytes[9], decryptedBytes[10], decryptedBytes[11]);
                if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
                if (brand === 'qt  ') return 'video/quicktime';
                if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
                if ((fallbackUrl || '').includes('voice/')) return 'audio/mp4';
                return 'video/mp4';
            }
        }
        const cleanUrl = (fallbackUrl || '').split('?')[0].toLowerCase();
        if (cleanUrl.endsWith('.png')) return 'image/png';
        if (cleanUrl.endsWith('.gif')) return 'image/gif';
        if (cleanUrl.endsWith('.webp')) return 'image/webp';
        if (cleanUrl.endsWith('.heic')) return 'image/heic';
        if (cleanUrl.endsWith('.mp4')) return 'video/mp4';
        if (cleanUrl.endsWith('.mov')) return 'video/quicktime';
        if (cleanUrl.endsWith('.m4a')) return 'audio/mp4';
        if (cleanUrl.endsWith('.mp3')) return 'audio/mpeg';
        if (cleanUrl.endsWith('.wav')) return 'audio/wav';
        if (cleanUrl.endsWith('.ogg')) return 'audio/ogg';
        if (cleanUrl.endsWith('.webm')) return 'audio/webm';
        if (cleanUrl.includes('voice/')) return 'audio/mp4';
        return 'image/jpeg';
    }

    function isProtectedMediaUrl(url) {
        if (!url || typeof url !== 'string') return false;
        if (url.startsWith('blob:') || url.startsWith('data:')) return false;
        return MEDIA_FOLDERS.some(folder => url.includes(folder));
    }

    function extractRepoPath(url) {
        if (!url) return null;
        const rawPrefix = `https://raw.githubusercontent.com/${OWNER_REPO}/main/`;
        if (url.startsWith(rawPrefix)) {
            return decodeURIComponent(url.slice(rawPrefix.length).split('?')[0]);
        }
        for (const folder of MEDIA_FOLDERS) {
            const idx = url.indexOf(folder);
            if (idx !== -1) {
                return decodeURIComponent(url.slice(idx).split('?')[0]);
            }
        }
        return null;
    }

    function toDatPath(pathStr) {
        return pathStr.replace(/\.(jpg|jpeg|png|gif|webp|heic|m4a|mp3|wav|webm|ogg)$/i, '.dat');
    }

    async function fetchRepoPathBytes(repoPath, token) {
        if (!repoPath) return null;
        if (token) {
            try {
                const apiRes = await origFetch.call(window, `https://api.github.com/repos/${OWNER_REPO}/contents/${repoPath}`, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/vnd.github.v3.raw'
                    }
                });
                if (apiRes.ok) {
                    return new Uint8Array(await apiRes.arrayBuffer());
                }
            } catch (e) {}
        }
        if (location.protocol === 'https:' || location.protocol === 'http:') {
            try {
                const relRes = await origFetch.call(window, repoPath);
                if (relRes.ok) {
                    return new Uint8Array(await relRes.arrayBuffer());
                }
            } catch (e) {}
        }
        return null;
    }

    async function resolveMediaUrl(url) {
        if (!url || !isProtectedMediaUrl(url)) return url;
        if (blobUrlCache.has(url)) return blobUrlCache.get(url);
        if (inflightPromises.has(url)) return inflightPromises.get(url);

        const promise = (async () => {
            const token = localStorage.getItem('loveGacha_githubToken');
            const repoPath = extractRepoPath(url);
            let rawBytes = null;

            if (repoPath) {
                rawBytes = await fetchRepoPathBytes(repoPath, token);
                if (!rawBytes) {
                    const datRepoPath = toDatPath(repoPath);
                    if (datRepoPath !== repoPath) {
                        rawBytes = await fetchRepoPathBytes(datRepoPath, token);
                    }
                }
            }

            if (!rawBytes && url.startsWith('http')) {
                try {
                    const directRes = await origFetch.call(window, url);
                    if (directRes.ok) {
                        rawBytes = new Uint8Array(await directRes.arrayBuffer());
                    }
                } catch (e) {}
            }

            if (!rawBytes) {
                inflightPromises.delete(url);
                return url;
            }

            const decryptedBytes = decryptBytes(rawBytes);
            const mimeType = detectMimeType(decryptedBytes, repoPath || url);
            const blob = new Blob([decryptedBytes], { type: mimeType });
            const blobUrl = URL.createObjectURL(blob);

            blobUrlCache.set(url, blobUrl);
            inflightPromises.delete(url);
            return blobUrl;
        })();

        inflightPromises.set(url, promise);
        return promise;
    }

    function applyNativeSrc(el, val) {
        if (el instanceof HTMLImageElement && imgSrcDesc && imgSrcDesc.set) {
            imgSrcDesc.set.call(el, val);
        } else if (el instanceof HTMLMediaElement && mediaSrcDesc && mediaSrcDesc.set) {
            mediaSrcDesc.set.call(el, val);
        } else {
            origSetAttribute.call(el, 'src', val);
        }
    }

    function bindEncryptedSrc(el, rawUrl) {
        if (!el || !rawUrl) return;
        if (!isProtectedMediaUrl(rawUrl)) {
            applyNativeSrc(el, rawUrl);
            return;
        }
        if (blobUrlCache.has(rawUrl)) {
            applyNativeSrc(el, blobUrlCache.get(rawUrl));
            return;
        }
        el.dataset.targetEncryptedSrc = rawUrl;
        if (el instanceof HTMLImageElement) {
            const currentAttr = el.getAttribute('src');
            if (!currentAttr || !currentAttr.startsWith('blob:')) {
                applyNativeSrc(el, TRANSPARENT_PIXEL);
            }
        }
        resolveMediaUrl(rawUrl).then(blobUrl => {
            if (el.dataset.targetEncryptedSrc === rawUrl && blobUrl) {
                applyNativeSrc(el, blobUrl);
            }
        });
    }

    if (imgSrcDesc && imgSrcDesc.set && imgSrcDesc.get) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
            configurable: true,
            enumerable: true,
            get: function () {
                return imgSrcDesc.get.call(this);
            },
            set: function (val) {
                if (isProtectedMediaUrl(val)) {
                    bindEncryptedSrc(this, val);
                } else {
                    imgSrcDesc.set.call(this, val);
                }
            }
        });
    }

    if (mediaSrcDesc && mediaSrcDesc.set && mediaSrcDesc.get) {
        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
            configurable: true,
            enumerable: true,
            get: function () {
                return mediaSrcDesc.get.call(this);
            },
            set: function (val) {
                if (isProtectedMediaUrl(val)) {
                    bindEncryptedSrc(this, val);
                } else {
                    mediaSrcDesc.set.call(this, val);
                }
            }
        });
    }

    function processMediaElement(el) {
        if (!el || !el.tagName) return;
        const tag = el.tagName.toUpperCase();
        if (tag !== 'IMG' && tag !== 'AUDIO' && tag !== 'VIDEO') return;
        const attrSrc = el.getAttribute('src');
        if (attrSrc && isProtectedMediaUrl(attrSrc)) {
            bindEncryptedSrc(el, attrSrc);
        }
    }

    function scanDocumentMedia(root = document) {
        if (!root || !root.querySelectorAll) return;
        root.querySelectorAll('img[src], audio[src], video[src]').forEach(processMediaElement);
    }

    function mountFloatingShieldButton() {
        if (!document.body || document.getElementById('lpFloatingShieldBtn')) return;
        const btn = document.createElement('button');
        btn.id = 'lpFloatingShieldBtn';
        btn.type = 'button';
        btn.onclick = openEncryptionModal;
        btn.className = 'fixed bottom-2.5 right-3 z-40 bg-white/95 hover:bg-rose-50 text-rose-500 text-[11px] font-bold px-2.5 py-1 rounded-full shadow-sm border border-rose-200 flex items-center gap-1 active:scale-95 transition-all';
        btn.innerHTML = '<span>🔐</span><span>图片乱码盾</span>';
        document.body.appendChild(btn);
    }

    function initDomObserver() {
        scanDocumentMedia(document);
        mountFloatingShieldButton();
        const observer = new MutationObserver(mutations => {
            for (const m of mutations) {
                if (m.type === 'attributes' && m.attributeName === 'src') {
                    processMediaElement(m.target);
                } else if (m.type === 'childList') {
                    m.addedNodes.forEach(node => {
                        if (node.nodeType === 1) {
                            processMediaElement(node);
                            scanDocumentMedia(node);
                        }
                    });
                }
            }
        });
        if (document.documentElement) {
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src']
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initDomObserver);
    } else {
        initDomObserver();
    }

    function disguiseMediaFilename(urlStr) {
        return urlStr.replace(/\.(jpg|jpeg|png|gif|webp|heic|m4a|mp3|wav|webm|ogg)(\?|$)/i, '.dat$2');
    }

    window.fetch = async function (input, init) {
        try {
            let urlStr = typeof input === 'string' ? input : (input && input.url) || '';
            if (init && init.method && init.method.toUpperCase() === 'PUT' &&
                urlStr.includes(`api.github.com/repos/${OWNER_REPO}/contents/`) &&
                MEDIA_FOLDERS.some(f => urlStr.includes(`/contents/${f}`)) &&
                typeof init.body === 'string') {
                const bodyObj = JSON.parse(init.body);
                if (bodyObj && bodyObj.content && !bodyObj._alreadyEncrypted) {
                    bodyObj.content = encryptBase64(bodyObj.content);
                    init = Object.assign({}, init, { body: JSON.stringify(bodyObj) });
                    if (typeof input === 'string') {
                        input = disguiseMediaFilename(urlStr);
                    }
                } else if (bodyObj && bodyObj._alreadyEncrypted) {
                    delete bodyObj._alreadyEncrypted;
                    init = Object.assign({}, init, { body: JSON.stringify(bodyObj) });
                }
            }
        } catch (e) {}
        return origFetch.call(this, input, init);
    };

    const origXhrOpen = XMLHttpRequest.prototype.open;
    const origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this._lpMethod = method ? method.toUpperCase() : '';
        if (this._lpMethod === 'PUT' && url &&
            url.includes(`api.github.com/repos/${OWNER_REPO}/contents/`) &&
            MEDIA_FOLDERS.some(f => url.includes(`/contents/${f}`))) {
            url = disguiseMediaFilename(url);
        }
        this._lpUrl = url || '';
        return origXhrOpen.call(this, method, url, arguments[2] !== undefined ? arguments[2] : true, arguments[3], arguments[4]);
    };
    XMLHttpRequest.prototype.send = function (body) {
        try {
            if (this._lpMethod === 'PUT' &&
                this._lpUrl.includes(`api.github.com/repos/${OWNER_REPO}/contents/`) &&
                MEDIA_FOLDERS.some(f => this._lpUrl.includes(`/contents/${f}`)) &&
                typeof body === 'string') {
                const bodyObj = JSON.parse(body);
                if (bodyObj && bodyObj.content) {
                    bodyObj.content = encryptBase64(bodyObj.content);
                    body = JSON.stringify(bodyObj);
                }
            }
        } catch (e) {}
        return origXhrSend.call(this, body);
    };

    /**
     * 一键扫描并加密 GitHub 云端仓库中所有存量图片与音频文件为 LPENCv02 乱码文本 + .dat 后缀
     */
    async function encryptAllCloudMedia(onProgress, disguiseAsDat = true) {
        const token = localStorage.getItem('loveGacha_githubToken');
        if (!token) throw new Error('未检测到 GitHub Token，请先在首页连接云端');

        const folders = ['photowall', 'travel', 'firsttimes', 'picture', 'voice'];
        const allFiles = [];

        for (const folder of folders) {
            const res = await origFetch.call(window, `https://api.github.com/repos/${OWNER_REPO}/contents/${folder}?t=${Date.now()}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            if (res.ok) {
                const list = await res.json();
                if (Array.isArray(list)) {
                    list.forEach(item => {
                        if (item.type === 'file' && item.size < 25 * 1024 * 1024) {
                            allFiles.push(item);
                        }
                    });
                }
            }
        }

        let encryptedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;

        for (let idx = 0; idx < allFiles.length; idx++) {
            const fileItem = allFiles[idx];
            if (typeof onProgress === 'function') {
                onProgress({
                    current: idx + 1,
                    total: allFiles.length,
                    path: fileItem.path,
                    encryptedCount,
                    skippedCount,
                    failedCount
                });
            }
            try {
                const rawRes = await origFetch.call(window, `https://api.github.com/repos/${OWNER_REPO}/contents/${fileItem.path}?t=${Date.now()}`, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/vnd.github.v3.raw'
                    }
                });
                if (!rawRes.ok) {
                    failedCount++;
                    continue;
                }
                const bytes = new Uint8Array(await rawRes.arrayBuffer());
                const alreadyV2 = hasMagicV2(bytes);
                const targetPath = disguiseAsDat ? toDatPath(fileItem.path) : fileItem.path;
                const needRename = targetPath !== fileItem.path;

                if (alreadyV2 && !needRename) {
                    skippedCount++;
                    continue;
                }

                // 若原本是明文或 V1，统一编码为 LPENCv02 满屏乱码文本流
                const encBytes = alreadyV2 ? bytes : encryptBytes(bytes);
                const b64Content = uint8ArrayToBase64(encBytes);

                if (needRename) {
                    let existingTargetSha = undefined;
                    try {
                        const checkTarget = await origFetch.call(window, `https://api.github.com/repos/${OWNER_REPO}/contents/${targetPath}?t=${Date.now()}`, {
                            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' }
                        });
                        if (checkTarget.ok) {
                            const targetMeta = await checkTarget.json();
                            existingTargetSha = targetMeta.sha;
                        }
                    } catch (e) {}

                    const putBody = {
                        message: `🔐 Disguise & garble ${targetPath} (LPENCv02)`,
                        content: b64Content,
                        _alreadyEncrypted: true
                    };
                    if (existingTargetSha) putBody.sha = existingTargetSha;

                    const putDatRes = await origFetch.call(window, `https://api.github.com/repos/${OWNER_REPO}/contents/${targetPath}`, {
                        method: 'PUT',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Accept': 'application/vnd.github.v3+json',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(putBody)
                    });
                    if (putDatRes.ok) {
                        await origFetch.call(window, `https://api.github.com/repos/${OWNER_REPO}/contents/${fileItem.path}`, {
                            method: 'DELETE',
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'Accept': 'application/vnd.github.v3+json',
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                message: `🗑️ Remove original image ${fileItem.path}`,
                                sha: fileItem.sha
                            })
                        });
                        encryptedCount++;
                    } else {
                        failedCount++;
                    }
                } else {
                    const putRes = await origFetch.call(window, `https://api.github.com/repos/${OWNER_REPO}/contents/${fileItem.path}`, {
                        method: 'PUT',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Accept': 'application/vnd.github.v3+json',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            message: `🔐 Garble media ${fileItem.path} (LPENCv02)`,
                            content: b64Content,
                            sha: fileItem.sha,
                            _alreadyEncrypted: true
                        })
                    });
                    if (putRes.ok) {
                        encryptedCount++;
                    } else {
                        failedCount++;
                    }
                }
            } catch (e) {
                failedCount++;
            }
        }

        if (disguiseAsDat) {
            const jsonFiles = ['data/Photos.json', 'data/Travel.json', 'data/FirstTimes.json', 'data/Hrj.json', 'data/Qrj.json'];
            for (const jf of jsonFiles) {
                try {
                    const jRes = await origFetch.call(window, `https://api.github.com/repos/${OWNER_REPO}/contents/${jf}?t=${Date.now()}`, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Accept': 'application/vnd.github.v3+json'
                        }
                    });
                    if (!jRes.ok) continue;
                    const jMeta = await jRes.json();
                    const oldText = decodeURIComponent(escape(window.atob(jMeta.content.replace(/\s/g, ''))));
                    const newText = oldText.replace(/(photowall|travel|firsttimes|picture|voice)\/([^"'\s]+?)\.(jpg|jpeg|png|gif|webp|heic|m4a|mp3|wav|webm|ogg)/gi, '$1/$2.dat');
                    if (newText !== oldText) {
                        const newB64 = window.btoa(unescape(encodeURIComponent(newText)));
                        await origFetch.call(window, `https://api.github.com/repos/${OWNER_REPO}/contents/${jf}`, {
                            method: 'PUT',
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'Accept': 'application/vnd.github.v3+json',
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                message: `🔐 Update media references in ${jf} to .dat`,
                                content: newB64,
                                sha: jMeta.sha
                            })
                        });
                    }
                } catch (e) {}
            }
        }

        localStorage.setItem('lovePlan_cloudMediaEncrypted', 'true');
        blobUrlCache.clear();
        scanDocumentMedia(document);
        return {
            total: allFiles.length,
            encryptedCount,
            skippedCount,
            failedCount
        };
    }

    function openEncryptionModal() {
        let modal = document.getElementById('lpCryptoModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'lpCryptoModal';
            modal.className = 'fixed inset-0 bg-black/55 backdrop-blur-sm z-[120] flex items-center justify-center p-4';
            modal.innerHTML = `
                <div class="bg-white rounded-3xl w-full max-w-sm p-6 shadow-2xl border-2 border-rose-200 flex flex-col gap-3 text-left relative">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2">
                            <span class="text-2xl">🔐</span>
                            <h3 class="text-base font-black text-rose-600">GitHub 媒体乱码防窥盾</h3>
                        </div>
                        <button id="lpCryptoCloseBtn" class="w-7 h-7 rounded-full bg-gray-100 text-gray-500 font-bold text-sm flex items-center justify-center hover:bg-rose-50 hover:text-rose-500">✕</button>
                    </div>
                    <div class="bg-rose-50/80 border border-rose-100 rounded-2xl p-3 text-xs text-gray-600 leading-relaxed space-y-1.5">
                        <p>🙈 <strong>看不出是图片 (.dat 伪装)</strong>：将图片/音频后缀统一改为 <code class="text-rose-500 font-bold">.dat</code> 数据块并删除原后缀文件，别人进 GitHub 连哪个是图片都看不出来。</p>
                        <p>🧩 <strong>点开全是乱码 (LPENCv02)</strong>：文件内容变成满屏乱码符号（如 <code class="text-rose-500">§¤÷×±≈...</code>），在 GitHub 直接点开只有乱码，而在本网页内自动解密正常打开！</p>
                    </div>
                    <label class="flex items-center gap-2 text-xs font-bold text-gray-700 bg-gray-50 px-3 py-2 rounded-xl border border-gray-200 cursor-pointer">
                        <input type="checkbox" id="lpDisguiseExtToggle" checked class="w-4 h-4 accent-rose-500 rounded">
                        <span>同时将云端图片后缀改为 .dat 并删除原图</span>
                    </label>
                    <div id="lpCryptoStatusBox" class="hidden bg-gray-900 text-emerald-400 font-mono text-[11px] p-3 rounded-xl leading-relaxed break-all max-h-28 overflow-y-auto">
                        准备就绪...
                    </div>
                    <button id="lpCryptoRunBtn" class="w-full py-3 bg-gradient-to-r from-rose-500 to-pink-500 text-white font-black text-xs rounded-2xl shadow-md hover:shadow-lg active:scale-95 transition-all">
                        🚀 一键将 GitHub 云端所有图片变成 .dat 乱码
                    </button>
                </div>
            `;
            document.body.appendChild(modal);

            document.getElementById('lpCryptoCloseBtn').onclick = () => {
                modal.classList.add('hidden');
            };
            document.getElementById('lpCryptoRunBtn').onclick = async () => {
                const btn = document.getElementById('lpCryptoRunBtn');
                const box = document.getElementById('lpCryptoStatusBox');
                const disguiseAsDat = document.getElementById('lpDisguiseExtToggle').checked;
                btn.disabled = true;
                btn.classList.add('opacity-50');
                box.classList.remove('hidden');
                box.innerText = '🔍 正在连接 GitHub 扫描 photowall / travel / firsttimes / picture / voice ...';
                try {
                    const res = await encryptAllCloudMedia((prog) => {
                        box.innerText = `🔐 [${prog.current}/${prog.total}] 正在变成乱码: ${prog.path}\n已完成伪装: ${prog.encryptedCount} | 已是乱码跳过: ${prog.skippedCount}`;
                    }, disguiseAsDat);
                    box.innerText = `🎉 全部完成！共扫描 ${res.total} 个云端文件：\n• 新伪装为 .dat 乱码：${res.encryptedCount} 个\n• 原本已是乱码跳过：${res.skippedCount} 个\n现在去 GitHub 仓库既看不出是图片，点开也全是乱码，网页内依然正常打开！`;
                    btn.innerText = '✅ 云端图片/语音已全部乱码化保护';
                } catch (err) {
                    box.innerText = `❌ 加密出错: ${err.message}`;
                    btn.innerText = '重试一键云端加密';
                } finally {
                    btn.disabled = false;
                    btn.classList.remove('opacity-50');
                }
            };
        } else {
            modal.classList.remove('hidden');
        }
    }

    window.LoveCrypto = {
        hasMagicHeader,
        encryptBytes,
        decryptBytes,
        encryptBase64,
        detectMimeType,
        resolveMediaUrl,
        isProtectedMediaUrl,
        scanDocumentMedia,
        encryptAllCloudMedia,
        openEncryptionModal
    };
})(window);
