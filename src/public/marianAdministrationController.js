/**
 * =============================================================================
 * MODULE: public/marianAdministrationController.js
 * RESPONSIBILITY: Shared frontend controller for Marian-only administration pages.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * =============================================================================
 */

import wixMembersFrontend from "wix-members-frontend";
import wixLocation from "wix-location";
import { checkStaffCollaboratorAccess } from "backend/security.web";
import { getMyStaffContext } from "backend/horario.web";
import {
    getCashierState,
    registerManualTransaction,
    registerXCount,
    registerZClosing,
} from "backend/cajas.web";
import {
    getInventoryDashboard,
    getInventoryReconciliationQueue,
} from "backend/inventario.web";
import {
    getQuarterlyTaxSummary,
    getLibroRegistroFacturasExpedidas,
} from "backend/fiscalAggregator.web";
import { askMarianAssistant } from "backend/marianAssistant.web";
import {
    previewManagerPackage,
    createManagerPackageVersion,
    downloadManagerPackageVersion,
    getManagerPackageHistory,
    getPreparedManagerPackages,
    emailManagerPackageVersion,
} from "backend/fiscalDocuments.web";
import {
    URLS,
    SDK_CONFIG,
    MONEY,
    makeTraceId,
    _safeTrim,
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";

function _postError(post, responseType, messageId, message) {
    post(responseType, {
        status: "ERROR",
        data: null,
        error: { code: "ACCESS_DENIED", message },
    }, messageId);
}

function _readYear(value) {
    const year = Number(value);
    return Number.isInteger(year) && year >= 2020 && year <= 2100 ? year : null;
}

function _readQuarter(value) {
    const quarter = Number(value);
    return [1, 2, 3, 4].includes(quarter) ? quarter : null;
}

function _readPositiveAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function _readEmail(value) {
    const email = _safeTrim(value).toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

function _readDocumentId(value) {
    const id = _safeTrim(value);
    return /^DOC_GESTORIA_(20\d{2}|21\d{2})_(T[1-4]|M(0[1-9]|1[0-2]))_PAQUETE_GESTORIA_V\d{4}$/.test(id) ? id : null;
}

export async function initMarianAdministration(widget, slug = "administracion") {
    const traceId = makeTraceId("marian-admin");
    if (!widget || typeof widget.postMessage !== "function") return;

    const member = await wixMembersFrontend.currentMember.getMember().catch(() => null);
    if (!member) {
        await wixMembersFrontend.authentication.promptLogin();
        return;
    }

    const [accessRes, staffContextRes] = await Promise.all([
        checkStaffCollaboratorAccess(traceId).catch(() => null),
        getMyStaffContext({ traceId }).catch(() => null),
    ]);

    const access = accessRes?.status === "SUCCESS" ? accessRes.data : null;
    const staffContext = staffContextRes?.status === "SUCCESS" ? staffContextRes.data : null;
    const isMarianManager = access?.isMarianManager === true;

    if (!isMarianManager) {
        wixLocation.to(URLS.SERVICIOS);
        return;
    }

    async function loadContext() {
        const [cashierRes, inventoryRes, queueRes] = await Promise.all([
            getCashierState({ traceId }).catch(() => null),
            getInventoryDashboard().catch(() => null),
            getInventoryReconciliationQueue().catch(() => null),
        ]);

        const today = new Date().toLocaleDateString("sv-SE", {
            timeZone: SDK_CONFIG.TZ,
        });

        return {
            isMarianManager: true,
            memberName: staffContext?.displayName || "Marian",
            timeZone: SDK_CONFIG.TZ,
            currencyCode: MONEY.DISPLAY_CURRENCY,
            today,
            cashierState: cashierRes?.status === "SUCCESS" ? cashierRes.data : null,
            inventory: inventoryRes?.status === "SUCCESS" ? inventoryRes.data : null,
            inventoryQueue: queueRes?.status === "SUCCESS" ? (queueRes.data?.items || []) : [],
        };
    }

    createWidgetBridge(widget, {
        slug,
        traceId,
        requiresServiceId: false,
        onContextReady: loadContext,
        onWidgetMessage: async (message, post) => {
            const type = String(message?.type || "").toUpperCase();
            const payload = message?.payload || {};
            const messageId = message?.messageId;

            if (!isMarianManager) {
                _postError(post, "ADMIN_ERROR", messageId, "Acceso exclusivo de Marian requerido");
                return;
            }

            if (type === "AI_CHAT") {
                const messageText = _safeTrim(payload.message);
                const history = Array.isArray(payload.history) ? payload.history : [];
                if (!messageText) {
                    _postError(post, "AI_CHAT_RES", messageId, "Escribe una consulta para el asistente");
                    return;
                }
                post("AI_CHAT_RES", await askMarianAssistant({
                    message: messageText,
                    history,
                    traceId,
                }), messageId);
                return;
            }

            if (type === "CASHIER_STATE") {
                post("CASHIER_STATE_RES", await getCashierState({
                    traceId,
                    diaKey: _safeTrim(payload.diaKey) || null,
                }), messageId);
                return;
            }

            if (type === "INVENTORY_DASH") {
                post("INVENTORY_DASH_RES", await getInventoryDashboard(), messageId);
                return;
            }

            if (type === "INVENTORY_QUEUE") {
                post("INVENTORY_QUEUE_RES", await getInventoryReconciliationQueue(), messageId);
                return;
            }

            if (type === "TPV_TX") {
                const amount = _readPositiveAmount(payload.amount);
                const paymentMethod = _safeTrim(payload.paymentMethod).toUpperCase();
                const transactionKind = _safeTrim(payload.transactionKind).toUpperCase() || "VENTA";
                const concept = _safeTrim(payload.concept);
                if (!amount || !["EFECTIVO", "TARJETA", "BIZUM"].includes(paymentMethod) || !["VENTA", "PROPINA"].includes(transactionKind) || !concept) {
                    _postError(post, "TPV_TX_RES", messageId, "Importe, forma de pago, naturaleza y concepto validos son obligatorios");
                    return;
                }
                post("TPV_TX_RES", await registerManualTransaction({
                    amount,
                    paymentMethod,
                    tipoMovimiento: transactionKind === "PROPINA" ? "PROPINA" : "",
                    concept,
                    resourceId: staffContext?.resourceId || null,
                    traceId,
                }), messageId);
                return;
            }

            if (type === "X_COUNT") {
                const diaKey = _safeTrim(payload.diaKey);
                const metalicoCaja = Number(payload.metalicoCaja);
                if (!diaKey || !Number.isFinite(metalicoCaja) || metalicoCaja < 0) {
                    _postError(post, "X_COUNT_RES", messageId, "Fecha y efectivo contado validos son obligatorios");
                    return;
                }
                post("X_COUNT_RES", await registerXCount(diaKey, {
                    metalicoCaja,
                    traceId,
                }), messageId);
                return;
            }

            if (type === "Z_CLOSING") {
                const diaKey = _safeTrim(payload.diaKey);
                if (!diaKey) {
                    _postError(post, "Z_CLOSING_RES", messageId, "La fecha de cierre es obligatoria");
                    return;
                }
                post("Z_CLOSING_RES", await registerZClosing(diaKey, { traceId }), messageId);
                return;
            }

            if (type === "DOCUMENT_PREVIEW" || type === "DOCUMENT_CREATE" || type === "DOCUMENT_HISTORY") {
                const year = _readYear(payload.year);
                const quarter = _readQuarter(payload.quarter);
                if (!year || !quarter) {
                    _postError(post, "DOCUMENT_RES", messageId, "Ejercicio y trimestre validos son obligatorios");
                    return;
                }
                const input = { year, quarter };
                if (type === "DOCUMENT_PREVIEW") {
                    post("DOCUMENT_PREVIEW_RES", await previewManagerPackage(input), messageId);
                    return;
                }
                if (type === "DOCUMENT_CREATE") {
                    post("DOCUMENT_CREATE_RES", await createManagerPackageVersion(input), messageId);
                    return;
                }
                post("DOCUMENT_HISTORY_RES", await getManagerPackageHistory(input), messageId);
                return;
            }

            if (type === "DOCUMENT_PREPARED") {
                post("DOCUMENT_PREPARED_RES", await getPreparedManagerPackages(), messageId);
                return;
            }

            if (type === "DOCUMENT_DOWNLOAD") {
                const documentId = _readDocumentId(payload.documentId);
                if (!documentId) {
                    _postError(post, "DOCUMENT_DOWNLOAD_RES", messageId, "La version documental no es valida");
                    return;
                }
                post("DOCUMENT_DOWNLOAD_RES", await downloadManagerPackageVersion({ documentId }), messageId);
                return;
            }

            if (type === "DOCUMENT_EMAIL") {
                const documentId = _readDocumentId(payload.documentId);
                const recipient = _readEmail(payload.recipient);
                if (!documentId || !recipient) {
                    _postError(post, "DOCUMENT_EMAIL_RES", messageId, "La version y el email de gestoria deben ser validos");
                    return;
                }
                if (payload.confirmed !== true) {
                    _postError(post, "DOCUMENT_EMAIL_RES", messageId, "Confirma expresamente el envio antes de continuar");
                    return;
                }
                post("DOCUMENT_EMAIL_RES", await emailManagerPackageVersion({
                    documentId,
                    recipient,
                    confirmed: true,
                }), messageId);
                return;
            }

            if (type === "FISCAL_SUMMARY") {
                const year = _readYear(payload.year);
                const quarter = _readQuarter(payload.quarter);
                if (!year || !quarter) {
                    _postError(post, "FISCAL_SUMMARY_RES", messageId, "Ejercicio y trimestre validos son obligatorios");
                    return;
                }
                post("FISCAL_SUMMARY_RES", await getQuarterlyTaxSummary(year, quarter, { traceId }), messageId);
                return;
            }

            if (type === "FISCAL_BOOK") {
                const year = _readYear(payload.year);
                const quarter = _readQuarter(payload.quarter);
                if (!year || !quarter) {
                    _postError(post, "FISCAL_BOOK_RES", messageId, "Ejercicio y trimestre validos son obligatorios");
                    return;
                }
                post("FISCAL_BOOK_RES", await getLibroRegistroFacturasExpedidas(year, quarter, { traceId }), messageId);
                return;
            }

            _postError(post, "ADMIN_ERROR", messageId, "Solicitud de gestion no permitida");
        },
    });
}
