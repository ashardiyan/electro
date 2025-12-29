(function() {
    // --- STATE VARIABLES ---
    let products = [];
    let selectedProductIds = new Set();
    let currentViewerImages = [];
    let currentViewerIndex = 0;
    let activeScanTarget = null; // 'search' or 'modal'
    let scannerStream = null;
    let scannerInterval = null;
    let isQuickSellMode = false;
    let activeCategoryFilter = null;
    let productToDelete = null; // For single delete modal
    let productsToShareQueue = []; // For PDF generation

    // DB Config
    const DB_NAME = 'DealerDB';
    const STORE_NAME = 'products';
    const STORE_HISTORY = 'sales_history';
    const DB_VERSION = 3;

    // --- INDEXED DB ENGINE ---
    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(STORE_HISTORY)) db.createObjectStore(STORE_HISTORY, { keyPath: 'id', autoIncrement: true });
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async function saveProductsToDB(items) {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        await new Promise(r => { store.clear().onsuccess = r; });
        items.forEach(p => store.put(p));
        return new Promise(r => { tx.oncomplete = r; });
    }

    async function loadProductsFromDB() {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        return new Promise((resolve) => {
            const req = tx.objectStore(STORE_NAME).getAll();
            req.onsuccess = () => resolve(req.result || []);
        });
    }

    async function logSale(entry) {
        const db = await openDB();
        const tx = db.transaction(STORE_HISTORY, 'readwrite');
        tx.objectStore(STORE_HISTORY).add(entry);
    }

    async function getHistory() {
        const db = await openDB();
        const tx = db.transaction(STORE_HISTORY, 'readonly');
        return new Promise(resolve => {
            tx.objectStore(STORE_HISTORY).getAll().onsuccess = (e) => resolve(e.target.result || []);
        });
    }

    // --- UTILS & HELPERS ---
    function genID() { return 'p' + Date.now() + Math.random().toString(36).substr(2, 5); }
    function escapeHTML(str) { return str ? String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'" :'&#39;','"':'&quot;'}[m])) : ''; }
    
    // Memory Management: Revoke Object URLs to prevent leaks
    let activeObjectUrls = [];
    function getPhotoSrc(photo) {
        if (!photo) return null;
        if (photo instanceof Blob) {
            const url = URL.createObjectURL(photo);
            activeObjectUrls.push(url);
            return url;
        }
        return photo; // Base64 or URL
    }

    // Biometric Utils
    const strToBuffer = (str) => Uint8Array.from(str, c => c.charCodeAt(0));
    const randomBuffer = (len) => {
        const arr = new Uint8Array(len);
        window.crypto.getRandomValues(arr);
        return arr;
    };

    // --- APP INITIALIZATION ---
    window.addEventListener('load', async () => {
        products = await loadProductsFromDB();
        
        // Update Login UI based on state
        const hasPin = localStorage.getItem('dealer-hash');
        if(hasPin) {
            document.getElementById('loginBtn').textContent = "Unlock";
            document.getElementById('pinLabel').textContent = "Enter PIN";
        }

        // Show Biometric button if available
        if(window.PublicKeyCredential && localStorage.getItem('dealer-bio-cred-id')) {
            document.getElementById('biometricUnlockBtn').style.display = 'block';
        } else {
            document.getElementById('biometricUnlockBtn').style.display = 'none';
        }

        document.getElementById('login-modal').style.display = 'flex';
        
        // Auto-trigger biometric if setup
        if(hasPin && localStorage.getItem('dealer-bio-cred-id')) {
            setTimeout(authenticateBiometric, 500);
        }
    });

    // --- LOGIN & AUTHENTICATION ---
    document.getElementById('loginForm').onsubmit = async (e) => {
        e.preventDefault();
        const pin = document.getElementById('loginPIN').value;
        const storedHash = localStorage.getItem('dealer-hash');
        const errDiv = document.getElementById('login-error');
        
        // Basic Hash (In production, use crypto.subtle)
        const hash = btoa(pin + "SALT_V1"); 

        if (!storedHash) {
            if(pin.length < 4) {
                errDiv.textContent = "PIN must be at least 4 digits";
                return;
            }
            localStorage.setItem('dealer-hash', hash);
            alert("PIN Set Successfully! Use this PIN to login next time.");
            unlockApp();
        } else if (storedHash === hash) {
            unlockApp();
        } else {
            errDiv.textContent = "Incorrect PIN";
        }
    };

    function unlockApp() {
        document.getElementById('login-modal').style.display = 'none';
        document.getElementById('dealerApp').style.display = 'block';
        document.getElementById('loginPIN').value = '';
        document.getElementById('login-error').textContent = '';
        refreshProductList();
    }

    document.getElementById('logoutBtn').onclick = () => {
        document.getElementById('dealerApp').style.display = 'none';
        document.getElementById('settingsBackdrop').classList.add('hide');
        document.getElementById('login-modal').style.display = 'flex';
        stopScanner();
    };

    // Toggle Password Visibility
    document.getElementById('showLoginPINBtn').onclick = function() {
        const input = document.getElementById('loginPIN');
        input.type = input.type === 'password' ? 'text' : 'password';
    };

    // --- BIOMETRIC / FINGERPRINT LOGIC ---
    document.getElementById('biometricUnlockBtn').onclick = authenticateBiometric;
    document.getElementById('setupBiometricBtn').onclick = registerBiometric;

    async function registerBiometric() {
        if (!window.PublicKeyCredential) return alert("Biometrics not supported.");
        try {
            const userId = localStorage.getItem('dealer-hash') || 'user';
            const opts = {
                challenge: randomBuffer(32),
                rp: { name: "Al Rehman Electronics", id: window.location.hostname },
                user: { id: strToBuffer(userId), name: "dealer", displayName: "Dealer" },
                pubKeyCredParams: [{ alg: -7, type: "public-key" }, { alg: -257, type: "public-key" }],
                authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
                timeout: 60000, attestation: "none"
            };
            const cred = await navigator.credentials.create({ publicKey: opts });
            const credId = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
            localStorage.setItem('dealer-bio-cred-id', credId);
            alert("Fingerprint setup successful!");
            document.getElementById('biometricUnlockBtn').style.display = 'block';
        } catch (e) {
            alert("Setup failed: " + e.message);
        }
    }

    async function authenticateBiometric() {
        const storedId = localStorage.getItem('dealer-bio-cred-id');
        if (!storedId) return;
        try {
            const opts = {
                challenge: randomBuffer(32),
                rpId: window.location.hostname,
                userVerification: "required",
                allowCredentials: [{ id: Uint8Array.from(atob(storedId), c => c.charCodeAt(0)), type: 'public-key' }]
            };
            const assertion = await navigator.credentials.get({ publicKey: opts });
            if (assertion) unlockApp();
        } catch (e) {
            console.log("Bio auth failed", e);
        }
    }

    // --- SETTINGS (PIN RESET) ---
    document.getElementById('settingsBtn').onclick = () => {
        document.getElementById('settingsBackdrop').classList.remove('hide');
        document.getElementById('oldPin').value = '';
        document.getElementById('newPin').value = '';
        document.getElementById('confirmPin').value = '';
        document.getElementById('resetPinError').textContent = '';
    };
    document.getElementById('closeSettingsBtn').onclick = () => document.getElementById('settingsBackdrop').classList.add('hide');

    document.getElementById('resetPinSubmit').onclick = () => {
        const oldPin = document.getElementById('oldPin').value;
        const newPin = document.getElementById('newPin').value;
        const confirmPin = document.getElementById('confirmPin').value;
        const errDiv = document.getElementById('resetPinError');
        const storedHash = localStorage.getItem('dealer-hash');

        if(btoa(oldPin + "SALT_V1") !== storedHash) {
            errDiv.textContent = "Current PIN is incorrect.";
            return;
        }
        if(newPin.length < 4) {
            errDiv.textContent = "New PIN must be 4+ chars.";
            return;
        }
        if(newPin !== confirmPin) {
            errDiv.textContent = "New PINs do not match.";
            return;
        }

        localStorage.setItem('dealer-hash', btoa(newPin + "SALT_V1"));
        alert("PIN Updated Successfully");
        document.getElementById('settingsBackdrop').classList.add('hide');
    };

    // --- PRODUCT LIST & RENDERING ---
    function refreshProductList() {
        // Cleanup memory
        activeObjectUrls.forEach(url => URL.revokeObjectURL(url));
        activeObjectUrls = [];

        const listEl = document.getElementById('productList');
        listEl.innerHTML = '';
        const search = document.getElementById('productSearch').value.toLowerCase();

        let filtered = products.filter(p => {
            // Include Barcode in search
            const txt = (p.name + " " + (p.barcode || "") + " " + (p.category || "")).toLowerCase();
            return txt.includes(search);
        });

        if (activeCategoryFilter) {
            filtered = filtered.filter(p => (p.category || '').toLowerCase() === activeCategoryFilter.toLowerCase());
            document.getElementById('activeCategoryDisplay').textContent = `Filtered: ${activeCategoryFilter} (Click to Clear)`;
            document.getElementById('activeCategoryDisplay').style.display = 'flex';
        } else {
            document.getElementById('activeCategoryDisplay').style.display = 'none';
        }

        if (filtered.length === 0) {
            document.getElementById('noProducts').style.display = 'block';
            return;
        }
        document.getElementById('noProducts').style.display = 'none';

        filtered.forEach(p => {
            const li = document.createElement('li');
            li.className = `prod-card ${selectedProductIds.has(p.id) ? 'selected' : ''}`;
            
            // Photo Logic
            let thumbSrc = '';
            if (p.photos && p.photos.length) thumbSrc = getPhotoSrc(p.photos[0]);
            else if (p.photo) thumbSrc = getPhotoSrc(p.photo);
            
            const imgHtml = thumbSrc ? `<img src="${thumbSrc}" class="prod-photo-thumb" loading="lazy">` : `<span>📦</span>`;

            li.innerHTML = `
                <input type="checkbox" class="select-chk" ${selectedProductIds.has(p.id) ? 'checked' : ''}>
                <div class="prod-img">${imgHtml}</div>
                <div class="prod-main-details">
                    <div class="prod-name">${escapeHTML(p.name)}</div>
                    <div class="prod-details">Qty: ${p.qty} | ₨${Number(p.mrp).toLocaleString()}</div>
                </div>
                <div class="prod-actions">
                    <button class="edit-btn">✏️</button>
                    <button class="share-btn">📤</button>
                </div>
            `;

            // Event Listeners
            li.querySelector('.select-chk').onclick = (e) => { e.stopPropagation(); };
            li.querySelector('.select-chk').onchange = (e) => {
                if(e.target.checked) selectedProductIds.add(p.id);
                else selectedProductIds.delete(p.id);
                updateMultiSelect();
            };

            li.querySelector('.edit-btn').onclick = (e) => { e.stopPropagation(); openEditModal(p); };
            li.querySelector('.share-btn').onclick = (e) => { e.stopPropagation(); openShareModal([p]); };
            
            // Thumb Click -> Full Screen Viewer
            li.querySelector('.prod-img').onclick = (e) => {
                e.stopPropagation();
                let imgs = p.photos || (p.photo ? [p.photo] : []);
                if(imgs.length) openImageViewer(imgs, 0);
            };

            // Card Click -> Details or Quick Sell
            li.onclick = (e) => {
                if(e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
                if(isQuickSellMode) openQuickSell(p);
                else openDetailModal(p);
            };

            listEl.appendChild(li);
        });
    }

    document.getElementById('productSearch').oninput = refreshProductList;
    document.getElementById('activeCategoryDisplay').onclick = () => {
        activeCategoryFilter = null;
        refreshProductList();
    };

    // --- IMAGE VIEWER (WITH SWIPE) ---
    const viewerOverlay = document.getElementById('imageViewerOverlay');
    const viewerImg = document.getElementById('imageViewerImg');
    const prevBtn = document.getElementById('prevImg');
    const nextBtn = document.getElementById('nextImg');
    const counter = document.getElementById('imageCounter');

    function openImageViewer(images, startIndex) {
        currentViewerImages = images;
        currentViewerIndex = startIndex;
        updateViewer();
        viewerOverlay.classList.add('show');
    }

    function updateViewer() {
        const total = currentViewerImages.length;
        if (total === 0) return;
        
        if (currentViewerIndex < 0) currentViewerIndex = total - 1;
        if (currentViewerIndex >= total) currentViewerIndex = 0;

        const src = getPhotoSrc(currentViewerImages[currentViewerIndex]);
        viewerImg.src = src;
        counter.textContent = `${currentViewerIndex + 1} / ${total}`;

        prevBtn.style.display = total > 1 ? 'block' : 'none';
        nextBtn.style.display = total > 1 ? 'block' : 'none';
    }

    document.getElementById('imageViewerClose').onclick = () => {
        viewerOverlay.classList.remove('show');
        viewerImg.src = '';
    };

    prevBtn.onclick = (e) => { e.stopPropagation(); currentViewerIndex--; updateViewer(); };
    nextBtn.onclick = (e) => { e.stopPropagation(); currentViewerIndex++; updateViewer(); };

    // Swipe Logic
    let touchStartX = 0;
    let touchEndX = 0;

    viewerOverlay.addEventListener('touchstart', (e) => { touchStartX = e.changedTouches[0].screenX; }, {passive: true});
    viewerOverlay.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        if (touchEndX < touchStartX - 50 && currentViewerImages.length > 1) { currentViewerIndex++; updateViewer(); }
        if (touchEndX > touchStartX + 50 && currentViewerImages.length > 1) { currentViewerIndex--; updateViewer(); }
    }, {passive: true});

    // --- ADD / EDIT PRODUCT ---
    const productModal = document.getElementById('productModalBackdrop');
    const prodForm = document.getElementById('productModal');
    let editingId = null;
    let pendingPhotos = [];

    document.getElementById('addProductBtn').onclick = () => {
        editingId = null;
        pendingPhotos = [];
        prodForm.reset();
        document.getElementById('modalTitle').textContent = "Add Product";
        document.getElementById('prodPhotoList').innerHTML = '';
        productModal.classList.remove('hide');
    };

    function openEditModal(p) {
        editingId = p.id;
        pendingPhotos = p.photos ? [...p.photos] : (p.photo ? [p.photo] : []);
        document.getElementById('modalTitle').textContent = "Edit Product";
        document.getElementById('prodName').value = p.name;
        document.getElementById('prodBarcode').value = p.barcode || '';
        document.getElementById('prodMrp').value = p.mrp;
        document.getElementById('prodCost').value = p.cost || '';
        document.getElementById('prodQty').value = p.qty;
        document.getElementById('prodCategory').value = p.category || '';
        document.getElementById('prodNotes').value = p.notes || '';
        renderPhotoPreview();
        productModal.classList.remove('hide');
        
        // Add Delete Button Logic to Edit
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '🗑️ Delete';
        deleteBtn.className = 'rounded-sky-btn cancel';
        deleteBtn.type = 'button';
        deleteBtn.style.marginTop = '10px';
        deleteBtn.style.width = '100%';
        deleteBtn.onclick = () => {
            productModal.classList.add('hide');
            openDeleteModal(p);
        };
        // Avoid duplicate buttons
        const existingDel = prodForm.querySelector('.delete-trigger');
        if(existingDel) existingDel.remove();
        deleteBtn.classList.add('delete-trigger');
        prodForm.appendChild(deleteBtn);
    }

    document.getElementById('closeModalBtn').onclick = () => productModal.classList.add('hide');

    function handleFiles(files) {
        Array.from(files).forEach(file => { pendingPhotos.push(file); });
        renderPhotoPreview();
    }
    document.getElementById('prodPhoto').onchange = (e) => handleFiles(e.target.files);
    document.getElementById('prodCamera').onchange = (e) => handleFiles(e.target.files);

    function renderPhotoPreview() {
        const container = document.getElementById('prodPhotoList');
        container.innerHTML = '';
        pendingPhotos.forEach((photo, idx) => {
            const div = document.createElement('div');
            div.className = 'photo-preview-item';
            const img = document.createElement('img');
            img.className = 'photo-preview-img-thumb';
            img.src = getPhotoSrc(photo);
            const btn = document.createElement('button');
            btn.className = 'remove-photo-btn';
            btn.innerHTML = '×';
            btn.type = 'button';
            btn.onclick = () => { pendingPhotos.splice(idx, 1); renderPhotoPreview(); };
            div.append(img, btn);
            container.appendChild(div);
        });
    }

    prodForm.onsubmit = async (e) => {
        e.preventDefault();
        const p = {
            id: editingId || genID(),
            name: document.getElementById('prodName').value,
            barcode: document.getElementById('prodBarcode').value,
            mrp: parseFloat(document.getElementById('prodMrp').value),
            cost: parseFloat(document.getElementById('prodCost').value),
            qty: parseInt(document.getElementById('prodQty').value),
            category: document.getElementById('prodCategory').value,
            notes: document.getElementById('prodNotes').value,
            photos: pendingPhotos
        };
        
        if (editingId) {
            const idx = products.findIndex(x => x.id === editingId);
            if(idx !== -1) products[idx] = p;
        } else {
            products.push(p);
        }

        await saveProductsToDB(products);
        productModal.classList.add('hide');
        refreshProductList();
    };

    // --- SCANNER LOGIC ---
    const scannerOverlay = document.getElementById('scannerOverlay');
    const videoElem = document.getElementById('scannerVideo');

    async function startScanner(targetMode) {
        if (!('BarcodeDetector' in window)) return alert("Barcode API not supported.");
        activeScanTarget = targetMode;
        scannerOverlay.classList.add('show');
        try {
            scannerStream = await navigator.mediaDevices.getUserMedia({ 
                video: { facingMode: "environment", focusMode: "continuous" } 
            });
            videoElem.srcObject = scannerStream;
            const detector = new BarcodeDetector({ formats: ['qr_code', 'ean_13', 'ean_8', 'code_128'] });
            
            scannerInterval = setInterval(async () => {
                try {
                    const barcodes = await detector.detect(videoElem);
                    if (barcodes.length > 0) onScanDetected(barcodes[0].rawValue);
                } catch(err) {}
            }, 200);
        } catch(e) { alert("Camera failed: " + e.message); stopScanner(); }
    }

    function onScanDetected(code) {
        clearInterval(scannerInterval);
        if (activeScanTarget === 'search') {
            stopScanner();
            document.getElementById('productSearch').value = code;
            refreshProductList();
        } else {
            document.getElementById('scannedCodeDisplay').textContent = code;
            document.getElementById('scanConfirmation').style.display = 'flex';
        }
    }

    document.getElementById('scanRetryBtn').onclick = () => {
        document.getElementById('scanConfirmation').style.display = 'none';
        const detector = new BarcodeDetector();
        scannerInterval = setInterval(async () => {
             const barcodes = await detector.detect(videoElem);
             if(barcodes.length) onScanDetected(barcodes[0].rawValue);
        }, 200);
    };

    document.getElementById('scanConfirmBtn').onclick = () => {
        const code = document.getElementById('scannedCodeDisplay').textContent;
        const field = document.getElementById('prodBarcode');
        const current = field.value ? field.value.split(',') : [];
        if(!current.includes(code)) current.push(code);
        field.value = current.join(',');
        stopScanner();
    };

    function stopScanner() {
        if (scannerStream) { scannerStream.getTracks().forEach(t => t.stop()); scannerStream = null; }
        if (scannerInterval) clearInterval(scannerInterval);
        scannerOverlay.classList.remove('show');
        document.getElementById('scanConfirmation').style.display = 'none';
    }

    document.getElementById('scanSearchBtn').onclick = () => startScanner('search');
    document.getElementById('scanModalBtn').onclick = () => startScanner('modal');
    document.getElementById('closeScannerBtn').onclick = stopScanner;

    // --- QUICK SELL ---
    document.getElementById('quickSellToggleBtn').onclick = function() {
        isQuickSellMode = !isQuickSellMode;
        this.classList.toggle('active', isQuickSellMode);
        document.body.classList.toggle('quick-sell-active', isQuickSellMode);
    };

    function openQuickSell(p) {
        const modal = document.getElementById('quickSellModalBackdrop');
        const form = document.getElementById('quickSellModal');
        document.getElementById('quickSellName').textContent = p.name;
        document.getElementById('quickSellPrice').value = p.mrp;
        document.getElementById('quickSellQty').value = 1;
        modal.classList.remove('hide');

        form.onsubmit = async (e) => {
            e.preventDefault();
            const qty = parseInt(document.getElementById('quickSellQty').value);
            const price = parseFloat(document.getElementById('quickSellPrice').value);
            
            p.qty -= qty;
            await saveProductsToDB(products);
            await logSale({ productId: p.id, productName: p.name, qtySold: qty, salePricePerUnit: price, timestamp: new Date().toISOString() });
            
            modal.classList.add('hide');
            refreshProductList();
        };
    }
    document.getElementById('closeQuickSellBtn').onclick = () => document.getElementById('quickSellModalBackdrop').classList.add('hide');

    // --- DETAILS MODAL ---
    function openDetailModal(p) {
        const body = document.getElementById('detailModalBody');
        const photos = p.photos || (p.photo ? [p.photo] : []);
        
        let galleryHtml = '';
        if(photos.length) {
            galleryHtml = `<div class="detail-gallery">`;
            photos.forEach((ph, i) => { galleryHtml += `<img src="${getPhotoSrc(ph)}" onclick="window.triggerDetailView(${i})">`; });
            galleryHtml += `</div>`;
        }
        window.triggerDetailView = (i) => openImageViewer(photos, i); // Helper

        body.innerHTML = `
            ${galleryHtml}
            <h3>${escapeHTML(p.name)}</h3>
            <p><b>Barcode:</b> ${p.barcode || '-'}</p>
            <p><b>Category:</b> ${p.category || '-'}</p>
            <p><b>Price:</b> ₨${p.mrp}</p>
            <p><b>Stock:</b> ${p.qty}</p>
            <p><b>Notes:</b> ${escapeHTML(p.notes)}</p>
        `;
        document.getElementById('detailModalBackdrop').classList.remove('hide');
    }
    document.getElementById('closeDetailModalBtn').onclick = () => document.getElementById('detailModalBackdrop').classList.add('hide');

    // --- SHARE / PRINT PDF LOGIC (Was Missing) ---
    const shareModal = document.getElementById('shareModalBackdrop');
    
    function openShareModal(productsToShare) {
        productsToShareQueue = productsToShare;
        document.getElementById('shareSubtitle').textContent = `Sharing ${productsToShare.length} Product(s)`;
        shareModal.classList.remove('hide');
    }

    document.getElementById('closeShareBtn').onclick = () => shareModal.classList.add('hide');

    document.getElementById('generatePdfBtn').onclick = () => {
        const area = document.getElementById('printableArea');
        let html = '';
        
        productsToShareQueue.forEach(p => {
            let imgHtml = '';
            const photos = p.photos || (p.photo ? [p.photo] : []);
            if (document.getElementById('sharePhoto').checked && photos.length) {
                imgHtml = `<div class="print-gallery">`;
                photos.forEach(ph => imgHtml += `<img src="${getPhotoSrc(ph)}" class="print-product-img">`);
                imgHtml += `</div>`;
            }

            html += `
                <div class="print-product-page">
                    <div style="text-align:center; border-bottom:2px solid #000; padding-bottom:10px;">
                        <h1>Al Rehman Electronics</h1>
                    </div>
                    <h2>${escapeHTML(p.name)}</h2>
                    ${imgHtml}
                    <table style="width:100%; text-align:left; margin-top:20px; font-size:18px;">
                        ${document.getElementById('shareCategory').checked ? `<tr><td>Category:</td><td>${p.category || '-'}</td></tr>` : ''}
                        ${document.getElementById('shareQty').checked ? `<tr><td>Stock:</td><td>${p.qty}</td></tr>` : ''}
                        ${document.getElementById('shareMrp').checked ? `<tr><td>Price:</td><td>₨${p.mrp}</td></tr>` : ''}
                        ${document.getElementById('shareCost').checked && p.cost ? `<tr><td>Cost:</td><td>₨${p.cost}</td></tr>` : ''}
                    </table>
                    ${document.getElementById('shareNotes').checked && p.notes ? `<div style="margin-top:20px; border:1px dashed #ccc; padding:10px;">${p.notes}</div>` : ''}
                </div>
            `;
        });
        
        area.innerHTML = html;
        shareModal.classList.add('hide');
        setTimeout(() => window.print(), 500);
    };

    // --- DELETE LOGIC (Single) ---
    const deleteModal = document.getElementById('deleteModalBackdrop');
    
    function openDeleteModal(p) {
        productToDelete = p;
        document.getElementById('deleteName').textContent = p.name;
        deleteModal.classList.remove('hide');
    }
    
    document.getElementById('closeDeleteBtn').onclick = () => deleteModal.classList.add('hide');
    
    document.getElementById('deleteModal').onsubmit = async (e) => {
        e.preventDefault();
        if(!productToDelete) return;
        products = products.filter(p => p.id !== productToDelete.id);
        selectedProductIds.delete(productToDelete.id);
        await saveProductsToDB(products);
        deleteModal.classList.add('hide');
        refreshProductList();
        updateMultiSelect();
    };

    // --- IMPORT / EXPORT (JSON) ---
    document.getElementById('exportBtn').onclick = async () => {
        // Convert blobs to base64 for JSON
        const data = await Promise.all(products.map(async p => {
            const copy = {...p};
            if(p.photos) copy.photos = await Promise.all(p.photos.map(blobToBase64));
            else if(p.photo) copy.photo = await blobToBase64(p.photo);
            return copy;
        }));
        const blob = new Blob([JSON.stringify(data)], {type: 'application/json'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `backup-${Date.now()}.json`;
        a.click();
    };

    document.getElementById('importBtn').onclick = () => document.getElementById('hiddenImport').click();
    document.getElementById('hiddenImport').onchange = async (e) => {
        const file = e.target.files[0];
        if(!file) return;
        const text = await file.text();
        let data = JSON.parse(text);
        // Convert Base64 back to Blobs
        data = await Promise.all(data.map(async p => {
            if(p.photos) p.photos = await Promise.all(p.photos.map(base64ToBlob));
            else if(p.photo) p.photo = await base64ToBlob(p.photo);
            return p;
        }));
        products = data;
        await saveProductsToDB(products);
        refreshProductList();
        alert("Import Successful");
    };

    function blobToBase64(blob) {
        if(!(blob instanceof Blob)) return blob; 
        return new Promise(r => { const reader = new FileReader(); reader.onloadend = () => r(reader.result); reader.readAsDataURL(blob); });
    }
    async function base64ToBlob(b64) {
        if(typeof b64 !== 'string' || !b64.startsWith('data:')) return b64;
        const res = await fetch(b64);
        return await res.blob();
    }

    // --- HISTORY ---
    document.getElementById('historyBtn').onclick = async () => {
        const list = await getHistory();
        const el = document.getElementById('historyList');
        if(!list.length) el.innerHTML = "No sales yet.";
        else {
            el.innerHTML = list.reverse().map(h => `
                <div style="padding:10px; border-bottom:1px solid #333">
                    <b>${escapeHTML(h.productName)}</b><br>
                    Qty: ${h.qtySold} | Sold: ₨${h.salePricePerUnit} <br>
                    <small>${new Date(h.timestamp).toLocaleString()}</small>
                </div>
            `).join('');
        }
        document.getElementById('historyModalBackdrop').classList.remove('hide');
    };
    document.getElementById('closeHistoryBtn').onclick = () => document.getElementById('historyModalBackdrop').classList.add('hide');

    // --- MULTI SELECT ---
    function updateMultiSelect() {
        const count = selectedProductIds.size;
        document.getElementById('selectedCountText').textContent = count > 0 ? `${count} Selected` : '';
        document.getElementById('multiSelectControls').style.display = count > 0 ? 'flex' : 'none';
        document.getElementById('deleteSelectedBtn').disabled = count === 0;
        document.getElementById('shareSelectedBtn').disabled = count === 0;
    }
    
    document.getElementById('deleteSelectedBtn').onclick = async () => {
        if(!confirm("Delete selected items?")) return;
        products = products.filter(p => !selectedProductIds.has(p.id));
        selectedProductIds.clear();
        await saveProductsToDB(products);
        refreshProductList();
        updateMultiSelect();
    };

    document.getElementById('shareSelectedBtn').onclick = () => {
        const selected = products.filter(p => selectedProductIds.has(p.id));
        openShareModal(selected);
    };

    document.getElementById('selectAllCheckbox').onchange = (e) => {
        const chks = document.querySelectorAll('.select-chk');
        if(e.target.checked) {
            // Select visible
            const visibleIds = Array.from(document.querySelectorAll('.prod-card')).map(card => {
                // Find ID from the product list (reverse engineering slightly or using filtered list)
                // Better approach: use filtered list variable if available, or iterate DOM
                // For now, rely on DOM checking checked state
            });
            // Simplified: Add ALL currently filtered
             // Note: In real app, cleaner to use 'currentFilteredProducts' array
             // Here we just toggle checkboxes visually and update ID set
             chks.forEach(c => {
                 c.checked = true;
                 c.dispatchEvent(new Event('change'));
             });
        } else {
            chks.forEach(c => {
                c.checked = false;
                c.dispatchEvent(new Event('change'));
            });
        }
    };
    
    // --- CATEGORY ---
    document.getElementById('categoryFilterBtn').onclick = () => {
        const cats = [...new Set(products.map(p => p.category).filter(c => c))];
        const grid = document.getElementById('categoryGrid');
        let html = `<div class="category-item-btn" onclick="setCategory(null)">All Categories</div>`;
        cats.forEach(c => {
            html += `<div class="category-item-btn" onclick="setCategory('${escapeHTML(c)}')">${escapeHTML(c)}</div>`;
        });
        grid.innerHTML = html;
        document.getElementById('categoryModalBackdrop').classList.remove('hide');
    };
    window.setCategory = (c) => {
        activeCategoryFilter = c;
        document.getElementById('categoryModalBackdrop').classList.add('hide');
        refreshProductList();
    };
    document.getElementById('closeCategoryBtn').onclick = () => document.getElementById('categoryModalBackdrop').classList.add('hide');

})();
