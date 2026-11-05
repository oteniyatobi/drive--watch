import crypto from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { IS_PROD, JWT_SECRET } from './config.js';
import { one } from './db.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'dw_session';
const SESSION_DAYS = 7;

export async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, 64);
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
    const [salt, hash] = stored.split(':');
    const expected = Buffer.from(hash, 'hex');
    const actual = await scrypt(password, Buffer.from(salt, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: IS_PROD, path: '/' };

export function startSession(res, userId) {
    const token = jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
    res.cookie(COOKIE, token, { ...cookieOptions, maxAge: SESSION_DAYS * 86400000 });
}

export function endSession(res) {
    res.clearCookie(COOKIE, cookieOptions);
}

/** Looks the user up on every request, so a deleted account loses access immediately. */
export async function requireAuth(req, res, next) {
    let userId;
    try {
        userId = jwt.verify(req.cookies[COOKIE] ?? '', JWT_SECRET, { algorithms: ['HS256'] }).sub;
    } catch {
        return res.status(401).json({ error: 'Please sign in.' });
    }
    const user = await one(
        `SELECT u.id, u.name, u.email, u.company_id, c.name AS company_name
         FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = $1`,
        [userId],
    );
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    req.user = user;
    req.companyId = user.company_id;
    next();
}
