/**
 * =============================================================================
 * MODULE: pages/ONLY STAFF.mvf3f.js
 * RESPONSIBILITY: Canonical Wix Editor page controller for staff operations.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * =============================================================================
 */

import wixMembersFrontend from "wix-members-frontend";
import wixLocation from "wix-location";
import { checkStaffCollaboratorAccess } from "backend/security.web";
import {
    getMyStaffContext,
    getStaffOptionsForAdmin,
    registrarFichaje,
    getEstadoJornada,
    getHistorialFichajes,
    calcularHorasTrabajadas,
    registrarAjusteHorario,
} from "backend/horario.web";
import {
    registerManualTransaction,
    getCashierState,
    registerZClosing,
    registerXCount,
} from "backend/cajas.web";
import {
    getInventoryDashboard,
    registerInternalInventoryUse,
    registerInventoryReceipt,
    getInventoryReconciliationQueue,
    markInventoryReconciliationApplied,
} from "backend/inventario.web";
import { URLS, SDK_CONFIG, MONEY, makeTraceId, _safeTrim } from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";

const WIDGET_ID = "#htmlOnlyStaff";
const CLOCK_TYPES = Object.freeze(["ENTRADA", "SALIDA", "PAUSA_INICIO", "PAUSA_FIN"]);
const CASHIER_METHODS = Object.freeze(["EFECTIVO", "TARJETA", "BIZUM"]);
const NAV_TARGETS = Object.freeze({ SERVICIOS: URLS.SERVICIOS });

function _postError(post, responseType, messageId, message, code = "INVALID_REQUEST") {
    post(responseType, {
        status: "ERROR",
        data: null,
        error: { code, message },
    }, messageId);
}

function _readDate(value) {
    const date = _safeTrim(value);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function _readPositiveAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function _readInventoryLine(payload = {}) {
    const sku = _safeTrim(payload.sku);
    const quantity = Math.abs(Number(payload.quantity) || 0);
    if (!sku || !Number.isFinite(quantity) || quantity <= 0) return null;
    return {
        sku,
        quantity,
        note: _safeTrim(payload.note),
        referenceId: _safeTrim(payload.referenceId) || null,
    };
}

function _requiresCashier(post, responseType, messageId, access) {
    if (access.isAdmin || access.isCajero) return false;
    _postError(post, responseType, messageId, "Se requieren permisos de caja", "CASHIER_REQUIRED");
    return true;
}

function _requiresAdmin(post, responseType, messageId, access) {
    if (access.isAdmin) return false;
    _postError(post, responseType, messageId, "Se requieren permisos de administrador", "ADMIN_REQUIRED");
    return true;
}

$w.onReady(async function () {
    const traceId = makeTraceId("only-staff");
    const widget = $w(WIDGET_ID);
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

    if (!access || !staffContext?.resourceId) {
        wixLocation.to(URLS.SERVICIOS);
        return;
    }

    const employeeResourceId = staffContext.resourceId;
    const staffOptionsRes = access.isAdmin
        ? await getStaffOptionsForAdmin({ traceId }).catch(() => null)
        : null;
    const staffOptions = staffOptionsRes?.status === "SUCCESS" && Array.isArray(staffOptionsRes.data)
        ? staffOptionsRes.data
        : [];

    createWidgetBridge(widget, {
        slug: "only-staff",
        traceId,
        requiresServiceId: false,
        onContextReady: async () => {
            const [stateRes, cashierRes, inventoryRes, inventoryQueueRes] = await Promise.all([
                getEstadoJornada(employeeResourceId, { traceId }).catch(() => null),
                access.isAdmin || access.isCajero
                    ? getCashierState({ traceId }).catch(() => null)
                    : Promise.resolve(null),
                getInventoryDashboard().catch(() => null),
                access.isAdmin || access.isCajero
                    ? getInventoryReconciliationQueue().catch(() => null)
                    : Promise.resolve(null),
            ]);

            return {
                employeeResourceId,
                employeeName: staffContext.displayName || "EMPLEADO",
                memberName: staffContext.displayName || "EMPLEADO",
                isAdmin: access.isAdmin === true,
                isCajero: access.isCajero === true,
                isMarianManager: access.isMarianManager === true,
                roleLabel: access.isAdmin ? "ADMINISTRACION" : (access.isCajero ? "CAJA" : "EQUIPO"),
                timeZone: SDK_CONFIG.TZ,
                currencyCode: MONEY.DISPLAY_CURRENCY,
                access,
                staffOptions,
                estadoInicial: stateRes?.status === "SUCCESS" ? stateRes.data : null,
                cashierState: cashierRes?.status === "SUCCESS" ? cashierRes.data : null,
                inventory: inventoryRes?.status === "SUCCESS" ? inventoryRes.data : null,
                inventoryQueue: inventoryQueueRes?.status === "SUCCESS"
                    ? (inventoryQueueRes.data?.items || [])
                    : [],
            };
        },
        onWidgetMessage: async (message, post) => {
            const type = String(message?.type || "").toUpperCase();
            const payload = message?.payload || {};
            const messageId = message?.messageId;

            if (type === "CLOCK") {
                const tipoFichaje = _safeTrim(payload.tipoFichaje).toUpperCase();
                if (!CLOCK_TYPES.includes(tipoFichaje)) {
                    _postError(post, "CLOCK_RES", messageId, "El tipo de fichaje no es valido");
                    return;
                }
                post("CLOCK_RES", await registrarFichaje({
                    resourceId: employeeResourceId,
                    tipoFichaje,
                    traceId,
                }), messageId);
                return;
            }

            if (type === "GET_STATE") {
                post("GET_STATE_RES", await getEstadoJornada(employeeResourceId, { traceId }), messageId);
                return;
            }

            if (type === "GET_HISTORY" || type === "HOURS_CALC") {
                const startDateYMD = _readDate(payload.startDateYMD);
                const endDateYMD = _readDate(payload.endDateYMD);
                if ((payload.startDateYMD && !startDateYMD) || (payload.endDateYMD && !endDateYMD)) {
                    _postError(post, `${type}_RES`, messageId, "El intervalo de fechas no es valido");
                    return;
                }
                if (type === "GET_HISTORY") {
                    post("GET_HISTORY_RES", await getHistorialFichajes(
                        employeeResourceId,
                        startDateYMD,
                        endDateYMD,
                        { traceId },
                    ), messageId);
                } else {
                    post("HOURS_CALC_RES", await calcularHorasTrabajadas(
                        employeeResourceId,
                        startDateYMD,
                        endDateYMD,
                        { traceId },
                    ), messageId);
                }
                return;
            }

            if (type === "ADJUSTMENT") {
                if (_requiresAdmin(post, "ADJUSTMENT_RES", messageId, access)) return;
                const targetResourceId = _safeTrim(payload.employeeId);
                const motivoAjuste = _safeTrim(payload.motivoAjuste);
                if (!targetResourceId || !motivoAjuste) {
                    _postError(post, "ADJUSTMENT_RES", messageId, "Empleado y motivo del ajuste son obligatorios");
                    return;
                }
                post("ADJUSTMENT_RES", await registrarAjusteHorario({
                    resourceId: targetResourceId,
                    motivoAjuste,
                    traceId,
                }), messageId);
                return;
            }

            if (type === "TPV_TX") {
                if (_requiresCashier(post, "TPV_TX_RES", messageId, access)) return;
                const amount = _readPositiveAmount(payload.amount);
                const paymentMethod = _safeTrim(payload.paymentMethod).toUpperCase();
                const transactionKind = _safeTrim(payload.transactionKind).toUpperCase() || "VENTA";
                const concept = _safeTrim(payload.concept);
                if (!amount || !CASHIER_METHODS.includes(paymentMethod) || !["VENTA", "PROPINA"].includes(transactionKind) || !concept) {
                    _postError(post, "TPV_TX_RES", messageId, "Importe, forma de pago, naturaleza y concepto validos son obligatorios");
                    return;
                }
                post("TPV_TX_RES", await registerManualTransaction({
                    amount,
                    paymentMethod,
                    tipoMovimiento: transactionKind === "PROPINA" ? "PROPINA" : "",
                    concept,
                    resourceId: employeeResourceId,
                    traceId,
                }), messageId);
                return;
            }

            if (type === "CASHIER_STATE") {
                if (_requiresCashier(post, "CASHIER_STATE_RES", messageId, access)) return;
                post("CASHIER_STATE_RES", await getCashierState({
                    traceId,
                    diaKey: _readDate(payload.diaKey) || null,
                }), messageId);
                return;
            }

            if (type === "X_COUNT") {
                if (_requiresCashier(post, "X_COUNT_RES", messageId, access)) return;
                const diaKey = _readDate(payload.diaKey);
                const metalicoCaja = Number(payload.metalicoCaja);
                if (!diaKey || !Number.isFinite(metalicoCaja) || metalicoCaja < 0) {
                    _postError(post, "X_COUNT_RES", messageId, "Fecha y efectivo contado validos son obligatorios");
                    return;
                }
                post("X_COUNT_RES", await registerXCount(diaKey, { metalicoCaja, traceId }), messageId);
                return;
            }

            if (type === "Z_CLOSING") {
                if (_requiresAdmin(post, "Z_CLOSING_RES", messageId, access)) return;
                const diaKey = _readDate(payload.diaKey);
                if (!diaKey) {
                    _postError(post, "Z_CLOSING_RES", messageId, "La fecha de cierre es obligatoria");
                    return;
                }
                post("Z_CLOSING_RES", await registerZClosing(diaKey, { traceId }), messageId);
                return;
            }

            if (type === "INVENTORY_DASH") {
                post("INVENTORY_DASH_RES", await getInventoryDashboard(), messageId);
                return;
            }

            if (type === "INVENTORY_USE" || type === "INVENTORY_RECEIPT") {
                if (type === "INVENTORY_RECEIPT" && _requiresCashier(post, "INVENTORY_RECEIPT_RES", messageId, access)) return;
                const line = _readInventoryLine(payload);
                if (!line) {
                    _postError(post, `${type}_RES`, messageId, "SKU y cantidad positiva son obligatorios");
                    return;
                }
                const request = {
                    batchToken: _safeTrim(payload.batchToken),
                    lines: [line],
                };
                if (type === "INVENTORY_USE") {
                    post("INVENTORY_USE_RES", await registerInternalInventoryUse(request), messageId);
                } else {
                    post("INVENTORY_RECEIPT_RES", await registerInventoryReceipt(request), messageId);
                }
                return;
            }

            if (type === "INVENTORY_QUEUE" || type === "INVENTORY_APPLY") {
                if (_requiresCashier(post, `${type}_RES`, messageId, access)) return;
                if (type === "INVENTORY_QUEUE") {
                    post("INVENTORY_QUEUE_RES", await getInventoryReconciliationQueue(), messageId);
                    return;
                }
                const reconciliationId = _safeTrim(payload.reconciliationId);
                if (!reconciliationId) {
                    _postError(post, "INVENTORY_APPLY_RES", messageId, "La conciliacion es obligatoria");
                    return;
                }
                post("INVENTORY_APPLY_RES", await markInventoryReconciliationApplied(
                    reconciliationId,
                    _safeTrim(payload.note),
                ), messageId);
                return;
            }

            if (type === "NAV") {
                const destination = NAV_TARGETS[_safeTrim(payload.target).toUpperCase()];
                if (!destination) {
                    _postError(post, "NAV_RES", messageId, "Destino de navegacion no permitido");
                    return;
                }
                wixLocation.to(destination);
                return;
            }

            _postError(post, "ONLY_STAFF_ERROR", messageId, "Solicitud de personal no permitida");
        },
    });
});
