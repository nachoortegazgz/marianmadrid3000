/**
 * =============================================================================
 * FILE: backend/responseUtils.js
 * VERSION: v18.3.8-strict-fine
 * RESPONSIBILITY: Centralized response standardization for all modules.
 * CONTENIDO:
 * 1. successResponse: respuesta estandar de exito.
 * 2. errorResponse: respuesta estandar de error.
 * 3. isSuccess: comprueba si una respuesta indica exito.
 * 4. extractError: extrae mensaje de error de cualquier estructura.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * HISTORIAL:
 * - v18.3.8-strict-fine: Header standardized during V2 compliance review.
 * =============================================================================
 */

import { _cloneDeep, _safeTrim } from 'public/mmUtils';

const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Respuesta de exito estandarizada.
 * @param {*} data - Datos a devolver.
 * @param {Object} metaExtra - Metadatos adicionales.
 * @returns {Object} Respuesta con status 'SUCCESS'.
 */
export function successResponse(data, metaExtra = {}) {
    const extra = metaExtra && typeof metaExtra === 'object' ? _cloneDeep(metaExtra) : {};
    return {
        status: 'SUCCESS',
        meta: {
            timestamp: new Date().toISOString(),
            ...extra
        },
        data,
        error: null
    };
}

/**
 * Respuesta de error estandarizada.
 * @param {string|Error|Object} code - Codigo de error o Error o objeto con code/message.
 * @param {string} [message] - Mensaje de error (opcional si code es Error u objeto).
 * @param {Object} metaExtra - Metadatos adicionales.
 * @returns {Object} Respuesta con status 'ERROR'.
 */
export function errorResponse(code, message, metaExtra = {}) {
    let finalCode = code;
    let finalMsg = message;

    if (code instanceof Error) {
        finalMsg = code.message || String(code);
        finalCode = code.code || code.name || 'UNKNOWN_ERROR';
    } else if (typeof code === 'object' && code !== null && (message === undefined || message === null)) {
        finalMsg = code.message || code.error || code.reason || JSON.stringify(code);
        finalCode = code.code || 'UNKNOWN_ERROR';
    } else if (typeof code === 'string' && (message === undefined || message === null)) {
        finalMsg = code;
        finalCode = 'UNKNOWN_ERROR';
    }

    const rawMsg = finalMsg instanceof Error ? finalMsg.message || String(finalMsg) : String(finalMsg || 'Unknown error');
    const safeMsg = _safeTrim(rawMsg);
    const truncatedMsg = safeMsg.length > MAX_ERROR_MESSAGE_LENGTH ?
        safeMsg.slice(0, MAX_ERROR_MESSAGE_LENGTH) + '...' :
        safeMsg;

    const extra = metaExtra && typeof metaExtra === 'object' ? _cloneDeep(metaExtra) : {};

    return {
        status: 'ERROR',
        meta: {
            timestamp: new Date().toISOString(),
            ...extra
        },
        data: null,
        error: {
            code: String(finalCode || 'UNKNOWN_ERROR'),
            message: truncatedMsg
        }
    };
}

/**
 * Comprueba si una respuesta indica exito.
 * @param {*} res - Respuesta a evaluar.
 * @returns {boolean} true si es exitosa.
 */
export function isSuccess(res) {
    if (!res) return false;
    if (res === true) return true;

    // Chequeo directo de status en la raiz
    const rawStatus = res?.status ?? res?.payload?.status ?? res?.data?.status;
    if (typeof rawStatus === 'string') {
        const norm = rawStatus.trim().toUpperCase();
        if (norm === 'SUCCESS' || norm === 'OK') return true;
    }

    if (rawStatus === 200 || res?.success === true) return true;
    return false;
}

/**
 * Extrae un mensaje de error de cualquier estructura (Error, objeto, string).
 * @param {*} err - Error a procesar.
 * @param {number} maxLen - Longitud maxima del mensaje.
 * @returns {string} Mensaje de error legible.
 */
export function extractError(err, maxLen = MAX_ERROR_MESSAGE_LENGTH) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return _safeTrim(err);

    if (err instanceof Error) {
        const codePrefix = err.code ? `${err.code}: ` : '';
        const msg = `${codePrefix}${err.message || String(err)}`;
        return msg.length > maxLen ? msg.slice(0, maxLen) + '...' : msg;
    }

    let code = null;
    let msg = null;

    if (typeof err === 'object' && err !== null) {
        code =
            err?.response?.data?.error?.code ||
            err?.error?.code ||
            err?.code ||
            err?.details?.code ||
            null;

        const candidates = [
            err?.response?.data?.error?.message,
            err?.response?.data?.message,
            typeof err?.response?.data?.error === 'string' ? err?.response?.data?.error : null,
            err?.error?.message,
            typeof err?.error === 'string' ? err?.error : null,
            err?.message,
            err?.details?.message,
            typeof err?.details === 'string' ? err?.details : null,
            typeof err?.reason === 'string' ? err?.reason : null,
            typeof err?.description === 'string' ? err?.description : null
        ];

        for (const candidate of candidates) {
            if (candidate && typeof candidate === 'string' && candidate.trim().length > 0) {
                msg = candidate.trim();
                break;
            }
        }

        if (!msg || msg === '{}') {
            try {
                const jsonStr = JSON.stringify(err);
                msg = jsonStr && jsonStr !== '{}' ? jsonStr : String(err?.message || err?.name || err || 'Unknown error');
            } catch (_) {
                msg = String(err?.message || err?.name || err || 'Unknown error');
            }
        }
    } else {
        msg = String(err);
    }

    const cleanedMsg = _safeTrim(msg);
    const finalMsg = cleanedMsg.length > maxLen ? cleanedMsg.slice(0, maxLen) + '...' : cleanedMsg;
    return code ? `${code}: ${finalMsg}` : finalMsg;
}
