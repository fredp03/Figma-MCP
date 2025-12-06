const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const NOTES_DIR = path.join(__dirname, 'notes');
const TEMPLATE_PATH = path.join(NOTES_DIR, 'template.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'Pages')));

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
    const existingSet = new Set(
        ignoreFileName ? existingFiles.filter((file) => file !== ignoreFileName) : existingFiles
    );
    const safeName = (candidate) => `${candidate}.json`;

    let candidate = safeName(base);
    let suffix = 1;
    while (existingSet.has(candidate)) {
        candidate = safeName(`${base}-${suffix}`);
        suffix += 1;
    }

    return candidate;
};

app.get('/api/notes', async (_req, res) => {
    try {
        const notes = await readNoteFiles();
        const sanitized = notes.map(({ fileName, ...note }) => ({
            ...note,
            secondaryContent: note.description || ''
        }));
        res.json(sanitized);
    } catch (error) {
        console.error('Error reading notes', error);
        res.status(500).json({ message: 'Failed to load notes.' });
    }
});

app.get('/api/notes/:id', async (req, res) => {
    try {
        const note = await findNoteFileById(req.params.id);
        if (!note) {
            res.status(404).json({ message: 'Note not found.' });
            return;
        }
        const { fileName, ...safeNote } = note;
        res.json({ ...safeNote, secondaryContent: safeNote.description || '' });
    } catch (error) {
        console.error('Error reading note', error);
        res.status(500).json({ message: 'Failed to load note.' });
    }
});

app.post('/api/notes', async (req, res) => {
    try {
        const { title, description = '', content = '' } = req.body || {};
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
        res.status(201).json({ ...saved, secondaryContent: saved.description || '' });
    } catch (error) {
        console.error('Error creating note', error);
        res.status(500).json({ message: 'Failed to create note.' });
    }
});

app.put('/api/notes/:id', async (req, res) => {
    try {
        const existing = await findNoteFileById(req.params.id);
        if (!existing) {
            res.status(404).json({ message: 'Note not found.' });
            return;
        }

        const { title, description, content } = req.body || {};
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
        res.json({ ...saved, secondaryContent: saved.description || '' });
    } catch (error) {
        console.error('Error updating note', error);
        res.status(500).json({ message: 'Failed to update note.' });
    }
});

app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'Pages', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
