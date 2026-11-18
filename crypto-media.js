/**
 * LovePlan 端到端媒体隐私加密引擎 (crypto-media.js)
 * 核心能力：
 * 1. 存储与传输加密：对 photowall/、travel/、firsttimes/、picture/、voice/ 下的所有图片、视频与音频采用 LPENCv01 二进制流加密（8字节魔数头 + 8字节随机 Nonce + RC4-Drop1024 密钥流）。
 * 2. 防泄漏保护：即使 GitHub 仓库设为 Public 或原始链接被他人获取，直接打开任何图片/音频文件均显示为无法解析的加密乱码，且彻底抹除文件头与 EXIF/GPS 拍摄元数据暴露风险。
 * 3. 无感自动加解密：
 *    - 上传拦截：自动拦截 fetch 与 XMLHttpRequest 向 GitHub 提交的媒体文件 Base64 并完成前端加密后再上传。
 *    - 渲染拦截：同时拦截 HTMLImageElement/HTMLMediaElement 的 src 属性与 DOM MutationObserver，支持离线/在线/私有库多通道拉取，在内存中毫秒级解密为 Blob URL 供页面渲染。
 *    - 云端存量一键迁移：提供 LoveCrypto.encryptAllCloudMedia(onProgress) 接口，支持在后台直接扫描并加密 GitHub 仓库中的存量明文图片与音频。
 */
(function (window) {
    'use strict';

    const MAGIC_HEADER = [0x4C, 0x50, 0x45, 0x4E, 0x43, 0x76, 0x30, 0x31]; // ASCII: "LPENCv01"
    const OWNER_REPO = '878481881-jpg/loveplan';
    const VAULT_SECRET = 'LovePlanVault_878481881_HengQin_2026_SecretKey!';
    const MEDIA_FOLDERS = ['photowall/', 'travel/', 'firsttimes/', 'picture/', 'voice/'];
    const KS_LEN = 65536; // 64KB per-file derived keystream block

    const blobUrlCache = new Map();
    const inflightPromises = new Map();

    // 1x1 透明占位 GIF，避免加密文件被浏览器当作损坏图片报错闪烁
    const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    const SECRET_BYTES = new TextEncoder().encode(VAULT_SECRET);

    const imgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    const mediaSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    const origSetAttribute = Element.prototype.setAttribute;
    const origFetch = window.fetch;

    function hasMagicHeader(bytes) {
        if (!bytes || bytes.length < 16) return false;
        for (let i = 0; i < 8; i++) {
            if (bytes[i] !== MAGIC_HEADER[i]) return false;
        }
        return true;
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

    /**
     * 64KB 循环密钥流变换（极速模式）
     */
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

    /**
     * 全长连续 RC4-Drop1024 密钥流变换（兼容全长流模式）
     */
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

    function encryptBytes(plainBytes) {
        if (hasMagicHeader(plainBytes)) return plainBytes;
        const nonce = new Uint8Array(8);
        if (window.crypto && window.crypto.getRandomValues) {
            window.crypto.getRandomValues(nonce);
        } else {
            for (let i = 0; i < 8; i++) nonce[i] = Math.floor(Math.random() * 256);
        }
        const encryptedPayload = cipherTransform64K(plainBytes, nonce);
        const result = new Uint8Array(16 + encryptedPayload.length);
        result.set(MAGIC_HEADER, 0);
        result.set(nonce, 8);
        result.set(encryptedPayload, 16);
        return result;
    }

    /**
     * 智能双模解密：对于 <=64KB 文件两种模式完全一致；对于 >64KB 文件自动校验尾部签名（JPEG EOI / PNG IEND）以无缝兼容
     */
    function decryptBytes(inputBytes) {
        if (!hasMagicHeader(inputBytes)) return inputBytes;
        const nonce = inputBytes.subarray(8, 16);
        const ciphertext = inputBytes.subarray(16);
        const out64K = cipherTransform64K(ciphertext, nonce);
        if (ciphertext.length <= KS_LEN) return out64K;

        const len = out64K.length;
        // 若是 JPEG (头 FF D8 FF)，检查 64K 模式尾部是否具有合法的 FF D9 结束标记
        if (out64K[0] === 0xFF && out64K[1] === 0xD8) {
            if (out64K[len - 2] === 0xFF && out64K[len - 1] === 0xD9) return out64K;
            const outFull = cipherTransformFull(ciphertext, nonce);
            if (outFull[len - 2] === 0xFF && outFull[len - 1] === 0xD9) return outFull;
            return out64K;
        }
        // 若是 PNG (头 89 50 4E 47)，检查尾部 IEND 块 (AE 42 60 82)
        if (out64K[0] === 0x89 && out64K[1] === 0x50 && out64K[2] === 0x4E && out64K[3] === 0x47) {
            if (out64K[len - 4] === 0xAE && out64K[len - 3] === 0x42 && out64K[len - 2] === 0x60 && out64K[len - 1] === 0x82) return out64K;
            const outFull = cipherTransformFull(ciphertext, nonce);
            if (outFull[len - 4] === 0xAE && outFull[len - 3] === 0x42 && outFull[len - 2] === 0x60 && outFull[len - 1] === 0x82) return outFull;
            return out64K;
        }
        return out64K;
    }

    function base64ToUint8Array(b64) {
        const clean = b64.replace(/\s/g, '');
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

    function encryptBase64(plainBase64) {
        if (!plainBase64) return plainBase64;
        const rawB64 = plainBase64.includes(',') ? plainBase64.split(',')[1] : plainBase64;
        const plainBytes = base64ToUint8Array(rawB64);
        const encBytes = encryptBytes(plainBytes);
        return uint8ArrayToBase64(encBytes);
    }

    function guessMimeType(url) {
        const cleanUrl = (url || '').split('?')[0].toLowerCase();
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

    async function resolveMediaUrl(url) {
        if (!url || !isProtectedMediaUrl(url)) return url;
        if (blobUrlCache.has(url)) return blobUrlCache.get(url);
        if (inflightPromises.has(url)) return inflightPromises.get(url);

        const promise = (async () => {
            const token = localStorage.getItem('loveGacha_githubToken');
            const repoPath = extractRepoPath(url);
            let rawBytes = null;

            // 通道 1：同源相对路径拉取（部署在 GitHub Pages 或本地 HTTP Server 时最快）
            if (repoPath && (location.protocol === 'https:' || location.protocol === 'http:')) {
                try {
                    const relRes = await origFetch.call(window, repoPath);
                    if (relRes.ok) {
                        rawBytes = new Uint8Array(await relRes.arrayBuffer());
                    }
                } catch (e) {}
            }

            // 通道 2：GitHub API Raw 流拉取（支持私有仓库鉴权与最新上传文件即时读取）
            if (!rawBytes && repoPath && token) {
                try {
                    const apiRes = await origFetch.call(window, `https://api.github.com/repos/${OWNER_REPO}/contents/${repoPath}`, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Accept': 'application/vnd.github.v3.raw'
                        }
                    });
                    if (apiRes.ok) {
                        rawBytes = new Uint8Array(await apiRes.arrayBuffer());
                    }
                } catch (e) {}
            }

            // 通道 3：直接拉取传入的远程 URL
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
            const mimeType = guessMimeType(repoPath || url);
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

    // 拦截 HTMLImageElement.prototype.src（涵盖 new Image().src = ... 与 imgEl.src = ...）
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

    // 拦截 HTMLMediaElement.prototype.src（涵盖 audio.src = ... 与 video.src = ...）
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

    function initDomObserver() {
        scanDocumentMedia(document);
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

    // 自动拦截上传：任何通过 fetch 或 XMLHttpRequest PUT 到 GitHub 媒体目录的文件自动加密
    window.fetch = async function (input, init) {
        try {
            const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
            if (init && init.method && init.method.toUpperCase() === 'PUT' &&
                urlStr.includes(`api.github.com/repos/${OWNER_REPO}/contents/`) &&
                MEDIA_FOLDERS.some(f => urlStr.includes(`/contents/${f}`)) &&
                typeof init.body === 'string') {
                const bodyObj = JSON.parse(init.body);
                if (bodyObj && bodyObj.content) {
                    bodyObj.content = encryptBase64(bodyObj.content);
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
        this._lpUrl = url || '';
        return origXhrOpen.apply(this, arguments);
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
     * 一键扫描并加密 GitHub 云端仓库中所有存量未加密的图片与音频文件
     */
    async function encryptAllCloudMedia(onProgress) {
        const token = localStorage.getItem('loveGacha_githubToken');
        if (!token) throw new Error('未检测到 GitHub Token');

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
                if (hasMagicHeader(bytes)) {
                    skippedCount++;
                    continue;
                }
                const encBytes = encryptBytes(bytes);
                const b64Content = uint8ArrayToBase64(encBytes);
                const putRes = await origFetch.call(window, `https://api.github.com/repos/${OWNER_REPO}/contents/${fileItem.path}`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        message: `🔐 Encrypt media ${fileItem.path} (LPENCv01)`,
                        content: b64Content,
                        sha: fileItem.sha
                    })
                });
                if (putRes.ok) {
                    encryptedCount++;
                } else {
                    failedCount++;
                }
            } catch (e) {
                failedCount++;
            }
        }

        return {
            total: allFiles.length,
            encryptedCount,
            skippedCount,
            failedCount
        };
    }

    window.LoveCrypto = {
        hasMagicHeader,
        encryptBytes,
        decryptBytes,
        encryptBase64,
        resolveMediaUrl,
        isProtectedMediaUrl,
        scanDocumentMedia,
        encryptAllCloudMedia
    };
})(window);
