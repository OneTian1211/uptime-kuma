const { log } = require("../../src/util");
const { R } = require("redbean-node");
const Monitor = require("../model/monitor");
const { monitorRoomName } = require("../util-server");
const { sendHeartbeatList } = require("../client");
const { UptimeKumaServer } = require("../uptime-kuma-server");

const io = UptimeKumaServer.getInstance().io;

/**
 * Handler for monitor subscription and lazy-loading events.
 * Per-monitor realtime events (heartbeat / uptime / avgPing / certInfo /
 * domainInfo / heartbeatList / importantHeartbeatList / updateMonitorIntoList /
 * deleteMonitorFromList) are routed to a per-monitor room (`monitor_${id}`).
 * Clients must explicitly subscribe via `subscribeMonitors` to receive them.
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.monitorSubscriptionSocketHandler = (socket) => {

    /**
     * Join the room for each monitor id so this socket receives its realtime events.
     * @returns {void}
     */
    socket.on("subscribeMonitors", async (monitorIDs, callback) => {
        try {
            if (!Array.isArray(monitorIDs)) {
                throw new Error("monitorIDs must be an array");
            }

            const promises = [];

            for (const id of monitorIDs) {
                const numId = Number(id);
                if (Number.isInteger(numId)) {
                    socket.join(monitorRoomName(numId));

                    // Push historical heartbeat and stats for this monitor
                    // so the client can render status immediately without
                    // waiting for the next realtime beat (up to 60s).
                    promises.push(sendHeartbeatList(socket, numId, false, true));
                    promises.push(Monitor.sendStats(io, numId, socket.userID));
                }
            }

            await Promise.all(promises);

            log.debug("monitorSubscription", `Socket ${socket.id} subscribed to ${monitorIDs.length} monitor(s)`);

            if (typeof callback === "function") {
                callback({
                    ok: true,
                });
            }
        } catch (e) {
            log.error("monitorSubscription", e.message);
            if (typeof callback === "function") {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        }
    });

    /**
     * Leave the room for each monitor id so this socket stops receiving events.
     * @returns {void}
     */
    socket.on("unsubscribeMonitors", async (monitorIDs, callback) => {
        try {
            if (!Array.isArray(monitorIDs)) {
                throw new Error("monitorIDs must be an array");
            }

            for (const id of monitorIDs) {
                const numId = Number(id);
                if (Number.isInteger(numId)) {
                    socket.leave(monitorRoomName(numId));
                }
            }

            log.debug("monitorSubscription", `Socket ${socket.id} unsubscribed from ${monitorIDs.length} monitor(s)`);

            if (typeof callback === "function") {
                callback({
                    ok: true,
                });
            }
        } catch (e) {
            log.error("monitorSubscription", e.message);
            if (typeof callback === "function") {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        }
    });

    /**
     * Fetch children of a group monitor (direct children only).
     * Returns a list of monitor objects shaped like the entries of `monitorList`.
     * @returns {void}
     */
    socket.on("getMonitorChildren", async (parentID, callback) => {
        try {
            if (typeof callback !== "function") {
                return;
            }

            const numParentID = Number(parentID);
            if (!Number.isInteger(numParentID)) {
                throw new Error("Invalid parentID");
            }

            const list = await R.find(
                "monitor",
                " user_id = ? AND parent = ? ORDER BY weight DESC, name ",
                [ socket.userID, numParentID ]
            );

            const monitorData = list.map((m) => ({
                id: m.id,
                active: m.active,
                name: m.name,
            }));
            const preloadData = await Monitor.preparePreloadData(monitorData);

            const result = {};
            list.forEach((m) => (result[m.id] = m.toJSON(preloadData)));

            callback({
                ok: true,
                parentID: numParentID,
                list: result,
            });
        } catch (e) {
            log.error("monitorSubscription", e.message);
            if (typeof callback === "function") {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        }
    });
};
