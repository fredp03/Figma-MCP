const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const { existsSync, createReadStream } = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const PAGES_DIR = path.join(ROOT_DIR, 'Pages');
const NOTES_DIR = path.join(ROOT_DIR, 'notes');
const TEMPLATE_PATH = path.join(NOTES_DIR, 'template.json');

const slugify = (value) =>
    value
        .toString()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');

const ensureNotesDirectory = async () => {
    if (!existsSync(NOTES_DIR)) {
        await fs.mkdir(NOTES_DIR, { recursive: true });
    }
};

const readNoteFiles = async () => {
    await ensureNotesDirectory();
    const files = await fs.readdir(NOTES_DIR);
    const noteFiles = files.filter((file) => file.endsWith('.json') && file !== path.basename(TEMPLATE_PATH));

    const notes = await Promise.all(
        noteFiles.map(async (file) => {
            const raw = await fs.readFile(path.join(NOTES_DIR, file), 'utf8');
            const parsed = JSON.parse(raw);
            return { ...parsed, fileName: file };
        })
    );

    return notes;
};

const getTemplate = async () => {
    await ensureNotesDirectory();
    const templateExists = existsSync(TEMPLATE_PATH);
    if (!templateExists) {
        const template = {
            title: 'Untitled Note',
            description: '',
            content: '',
            updatedAt: null
        };
        await fs.writeFile(TEMPLATE_PATH, JSON.stringify(template, null, 2), 'utf8');
        return template;
    }

    const raw = await fs.readFile(TEMPLATE_PATH, 'utf8');
    return JSON.parse(raw);
};

const writeNoteFile = async (fileName, data) => {
    const payload = {
        ...data,
        updatedAt: new Date().toISOString()
    };
    await fs.writeFile(path.join(NOTES_DIR, fileName), JSON.stringify(payload, null, 2), 'utf8');
    return payload;
};

const findNoteFileById = async (id) => {
    const notes = await readNoteFiles();
    return notes.find((note) => note.id === id) || null;
};

const generateFileName = async (title, ignoreFileName = null) => {
    const base = slugify(title || 'untitled-note') || 'untitled-note';
    const existingFiles = await fs.readdir(NOTES_DIR);
    const existingSet = new Set(ignoreFileName ? existingFiles.filter((file) => file !== ignoreFileName) : existingFiles);
    const safeName = (candidate) => `${candidate}.json`;

    let candidate = safeName(base);
    let suffix = 1;
    while (existingSet.has(candidate)) {
        candidate = safeName(`${base}-${suffix}`);
        suffix += 1;
    }

    return candidate;
};

const parseJsonBody = async (req) =>
    new Promise((resolve, reject) => {
        let body = '';

        req.on('data', (chunk) => {
            body += chunk.toString();
            if (body.length > 1e6) {
                req.connection.destroy();
                reject(new Error('Payload too large'));
            }
        });

        req.on('end', () => {
            if (!body.trim()) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(error);
            }
        });

        req.on('error', reject);
    });

const sendJson = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
};

const sendText = (res, status, message) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(message);
};

const serveStaticFile = async (res, filePath) => {
    try {
        const stream = createReadStream(filePath);
        const extension = path.extname(filePath).toLowerCase();
        const contentType = extension === '.html' ? 'text/html' : 'text/plain';
        res.writeHead(200, { 'Content-Type': contentType });
        stream.pipe(res);
    } catch (error) {
        console.error('Error serving static file', error);
        sendText(res, 404, 'Not found');
    }
};

const handleApiRequest = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    try {
        if (req.method === 'GET' && pathname === '/api/notes') {
            const notes = await readNoteFiles();
            const sanitized = notes.map(({ fileName, ...note }) => ({
                ...note,
                secondaryContent: note.description || ''
            }));
            sendJson(res, 200, sanitized);
            return true;
        }

        if (req.method === 'GET' && pathname.startsWith('/api/notes/')) {
            const id = pathname.split('/').pop();
            const note = await findNoteFileById(id);
            if (!note) {
                sendJson(res, 404, { message: 'Note not found.' });
                return true;
            }
            const { fileName, ...safeNote } = note;
            sendJson(res, 200, { ...safeNote, secondaryContent: safeNote.description || '' });
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/notes') {
            const { title, description = '', content = '' } = await parseJsonBody(req);
            const template = await getTemplate();
            const id = crypto.randomUUID ? crypto.randomUUID() : `note-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const resolvedTitle = (title || template.title || 'Untitled Note').trim() || 'Untitled Note';
            const fileName = await generateFileName(resolvedTitle);

            const newNote = {
                ...template,
                id,
                title: resolvedTitle,
                description: description ?? template.description ?? '',
                content: content ?? template.content ?? ''
            };

            const saved = await writeNoteFile(fileName, newNote);
            sendJson(res, 201, { ...saved, secondaryContent: saved.description || '' });
            return true;
        }

        if (req.method === 'PUT' && pathname.startsWith('/api/notes/')) {
            const id = pathname.split('/').pop();
            const existing = await findNoteFileById(id);
            if (!existing) {
                sendJson(res, 404, { message: 'Note not found.' });
                return true;
            }

            const { title, description, content } = await parseJsonBody(req);
            const merged = {
                ...existing,
                title: typeof title === 'string' ? title.trim() || existing.title : existing.title,
                description: typeof description === 'string' ? description : existing.description,
                content: typeof content === 'string' ? content : existing.content
            };

            const currentFileName = existing.fileName;
            const desiredFileName = await generateFileName(merged.title, currentFileName);
            const finalFileName = currentFileName === desiredFileName ? currentFileName : desiredFileName;

            const saved = await writeNoteFile(finalFileName, merged);

            if (currentFileName !== finalFileName && existsSync(path.join(NOTES_DIR, currentFileName))) {
                await fs.rm(path.join(NOTES_DIR, currentFileName));
            }

            sendJson(res, 200, { ...saved, secondaryContent: saved.description || '' });
            return true;
        }
    } catch (error) {
        console.error('API error', error);
        sendJson(res, 500, { message: 'Failed to process request.' });
        return true;
    }

    return false;
};

const server = http.createServer(async (req, res) => {
    if (req.url && req.url.startsWith('/api/')) {
        const handled = await handleApiRequest(req, res);
        if (handled) return;
    }

    const urlPath = req.url === '/' ? '/index.html' : req.url;
    const resolvedPath = path.join(PAGES_DIR, decodeURIComponent(urlPath.split('?')[0]));

    if (resolvedPath.startsWith(PAGES_DIR) && existsSync(resolvedPath)) {
        await serveStaticFile(res, resolvedPath);
        return;
    }

    sendText(res, 404, 'Not found');
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
