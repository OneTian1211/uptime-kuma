/*
 * For Client Socket
 */
const { TimeLogger } = require("../src/util");
const { R } = require("redbean-node");
const { UptimeKumaServer } = require("./uptime-kuma-server");
const server = UptimeKumaServer.getInstance();
const io = server.io;
const { setting, emitToMonitor } = require("./util-server");
const checkVersion = require("./check-version");
const Database = require("./database");

/**
 * Send list of notification providers to client
 * @param {Socket} socket Socket.io socket instance
 * @returns {Promise<Bean[]>} List of notifications
 */
async function sendNotificationList(socket) {
    const timeLogger = new TimeLogger();

    let result = [];
    let list = await R.find("notification", " user_id = ? ", [socket.userID]);

    for (let bean of list) {
        let notificationObject = bean.export();
        notificationObject.isDefault = notificationObject.isDefault === 1;
        notificationObject.active = notificationObject.active === 1;
        result.push(notificationObject);
    }

    io.to(socket.userID).emit("notificationList", result);

    timeLogger.print("Send Notification List");

    return list;
}

/**
 * Send Heartbeat History list to socket
 * @param {Socket} socket Socket.io instance
 * @param {number} monitorID ID of monitor to send heartbeat history
 * @param {boolean} toUser  True = send to all browsers with the same user id, False = send to the current browser only
 * @param {boolean} overwrite Overwrite client-side's heartbeat list
 * @returns {Promise<void>}
 */
async function sendHeartbeatList(socket, monitorID, toUser = false, overwrite = false) {
    let list = await R.getAll(
        `
        SELECT * FROM heartbeat
        WHERE monitor_id = ?
        ORDER BY time DESC
        LIMIT 100
    `,
        [monitorID]
    );

    let result = list.reverse();

    if (toUser) {
        emitToMonitor(io, monitorID, "heartbeatList", monitorID, result, overwrite);
    } else {
        socket.emit("heartbeatList", monitorID, result, overwrite);
    }
}

/**
 * Batch-send the latest heartbeat for every monitor so the Quick Stats numbers
 * on the dashboard populate immediately after login, before the per-monitor
 * `heartbeatList` round trips complete. Single SQL + single emit, regardless
 * of monitor count. The frontend temporarily stores each beat as a 1-element
 * array under `heartbeatList[monitorID]`; the subsequent full heartbeatList
 * event replaces it.
 * @param {Socket} socket Socket.io instance
 * @param {object} monitorList Monitor map keyed by monitorID (only those will receive beats)
 * @param {boolean} toUser True = broadcast to all sockets of the user, False = current socket only
 * @returns {Promise<void>}
 */
async function sendLastHeartbeatBatch(socket, monitorList, toUser = false) {
    const monitorIDs = Object.keys(monitorList);
    if (monitorIDs.length === 0) {
        return;
    }

    const placeholders = monitorIDs.map(() => "?").join(",");
    const list = await R.getAll(
        `
        SELECT h.* FROM heartbeat h
        INNER JOIN (
            SELECT monitor_id, MAX(time) AS max_time
            FROM heartbeat
            WHERE monitor_id IN (${placeholders})
            GROUP BY monitor_id
        ) latest ON h.monitor_id = latest.monitor_id AND h.time = latest.max_time
        `,
        monitorIDs
    );

    const batch = {};
    for (const beat of list) {
        batch[beat.monitor_id] = [ beat ];
    }

    if (toUser) {
        io.to(socket.userID).emit("lastHeartbeatBatch", batch);
    } else {
        socket.emit("lastHeartbeatBatch", batch);
    }
}

/**
 * Aggregate Quick-Stats counters for the dashboard root-monitor set so the
 * "正常/故障/维护/未知/暂停" numbers can render before monitorList finishes
 * merging.  Single SQL roundtrip per dimension (monitor counts, heartbeat
 * status counts).
 * @param {Socket} socket Socket.io socket instance
 * @param {object} monitorList Monitor map keyed by monitorID (root set only)
 * @param {boolean} toUser True = broadcast to all sockets of the user, False = current socket only
 * @returns {Promise<object>} Summary object
 */
async function sendMonitorSummary(socket, monitorList, toUser = false) {
    const monitorIDs = Object.keys(monitorList);
    if (monitorIDs.length === 0) {
        return { total: 0, active: 0, pause: 0, up: 0, down: 0, pending: 0, maintenance: 0, unknown: 0 };
    }

    const placeholders = monitorIDs.map(() => "?").join(",");

    const monitorAggRows = await R.getAll(
        `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) AS pause
        FROM monitor
        WHERE id IN (${placeholders})`,
        monitorIDs
    );
    const monitorAgg = monitorAggRows[0] || { total: 0, active: 0, pause: 0 };

    const statusRows = await R.getAll(
        `SELECT h.status, COUNT(*) AS cnt
         FROM heartbeat h
         INNER JOIN (
             SELECT monitor_id, MAX(time) AS max_time
             FROM heartbeat
             WHERE monitor_id IN (${placeholders})
             GROUP BY monitor_id
         ) latest ON h.monitor_id = latest.monitor_id AND h.time = latest.max_time
         GROUP BY h.status`,
        monitorIDs
    );

    const summary = {
        total: Number(monitorAgg.total) || 0,
        active: Number(monitorAgg.active) || 0,
        pause: Number(monitorAgg.pause) || 0,
        up: 0,
        down: 0,
        pending: 0,
        maintenance: 0,
        unknown: 0,
    };

    let activeWithHeartbeat = 0;
    for (const row of statusRows) {
        const cnt = Number(row.cnt);
        if (row.status === 1) {
            summary.up += cnt;
            activeWithHeartbeat += cnt;
        } else if (row.status === 0) {
            summary.down += cnt;
            activeWithHeartbeat += cnt;
        } else if (row.status === 2) {
            summary.pending += cnt;
            activeWithHeartbeat += cnt;
        } else if (row.status === 3) {
            summary.maintenance += cnt;
            activeWithHeartbeat += cnt;
        }
    }
    // Match `stats` computed semantics: active monitors without a heartbeat
    // yet count as unknown.
    const withoutHeartbeat = summary.active - activeWithHeartbeat;
    if (withoutHeartbeat > 0) {
        summary.unknown = withoutHeartbeat;
    }

    if (toUser) {
        io.to(socket.userID).emit("monitorSummary", summary);
    } else {
        socket.emit("monitorSummary", summary);
    }

    return summary;
}

/**
 * Important Heart beat list (aka event list)
 * @param {Socket} socket Socket.io instance
 * @param {number} monitorID ID of monitor to send heartbeat history
 * @param {boolean} toUser  True = send to all browsers with the same user id, False = send to the current browser only
 * @param {boolean} overwrite Overwrite client-side's heartbeat list
 * @returns {Promise<void>}
 */
async function sendImportantHeartbeatList(socket, monitorID, toUser = false, overwrite = false) {
    const timeLogger = new TimeLogger();

    let list = await R.find(
        "heartbeat",
        `
        monitor_id = ?
        AND important = 1
        ORDER BY time DESC
        LIMIT 500
    `,
        [monitorID]
    );

    timeLogger.print(`[Monitor: ${monitorID}] sendImportantHeartbeatList`);

    const result = list.map((bean) => bean.toJSON());

    if (toUser) {
        io.to(socket.userID).emit("importantHeartbeatList", monitorID, result, overwrite);
    } else {
        socket.emit("importantHeartbeatList", monitorID, result, overwrite);
    }
}

/**
 * Push the first page of important heartbeats plus the total count in a
 * single emit so the Dashboard event table can render without waiting for
 * the monitorImportantHeartbeatListCount + monitorImportantHeartbeatListPaged
 * round trips. Mirrors the semantics of those two handlers (important = 1,
 * no monitor filter) so pagination beyond page 1 stays consistent.
 * @param {Socket} socket Socket.io instance
 * @param {number} perPage Page size for the initial page
 * @returns {Promise<void>}
 */
async function sendImportantHeartbeatsInitial(socket, perPage = 25) {
    const list = await R.find(
        "heartbeat",
        `important = 1 ORDER BY time DESC LIMIT ?`,
        [perPage]
    );

    const count = await R.count("heartbeat", "important = 1");

    socket.emit("importantHeartbeatsInitial", {
        total: count,
        entries: list.map((bean) => bean.toJSON()),
        perPage,
    });
}

/**
 * Emit proxy list to client
 * @param {Socket} socket Socket.io socket instance
 * @returns {Promise<Bean[]>} List of proxies
 */
async function sendProxyList(socket) {
    const timeLogger = new TimeLogger();

    const list = await R.find("proxy", " user_id = ? ", [socket.userID]);
    io.to(socket.userID).emit(
        "proxyList",
        list.map((bean) => bean.export())
    );

    timeLogger.print("Send Proxy List");

    return list;
}

/**
 * Emit API key list to client
 * @param {Socket} socket Socket.io socket instance
 * @returns {Promise<void>}
 */
async function sendAPIKeyList(socket) {
    const timeLogger = new TimeLogger();

    let result = [];
    const list = await R.find("api_key", "user_id=?", [socket.userID]);

    for (let bean of list) {
        result.push(bean.toPublicJSON());
    }

    io.to(socket.userID).emit("apiKeyList", result);
    timeLogger.print("Sent API Key List");

    return list;
}

/**
 * Emits the version information to the client.
 * @param {Socket} socket Socket.io socket instance
 * @param {boolean} hideVersion Should we hide the version information in the response?
 * @returns {Promise<void>}
 */
async function sendInfo(socket, hideVersion = false) {
    const info = {
        primaryBaseURL: await setting("primaryBaseURL"),
        serverTimezone: await server.getTimezone(),
        serverTimezoneOffset: server.getTimezoneOffset(),
    };
    if (!hideVersion) {
        info.version = checkVersion.version;
        info.latestVersion = checkVersion.latestVersion;
        info.isContainer = process.env.UPTIME_KUMA_IS_CONTAINER === "1";
        info.dbType = Database.dbConfig.type;
        info.runtime = {
            platform: process.platform, // linux or win32
            arch: process.arch, // x86 or arm
        };
    }

    socket.emit("info", info);
}

/**
 * Send list of docker hosts to client
 * @param {Socket} socket Socket.io socket instance
 * @returns {Promise<Bean[]>} List of docker hosts
 */
async function sendDockerHostList(socket) {
    const timeLogger = new TimeLogger();

    let result = [];
    let list = await R.find("docker_host", " user_id = ? ", [socket.userID]);

    for (let bean of list) {
        result.push(bean.toJSON());
    }

    io.to(socket.userID).emit("dockerHostList", result);

    timeLogger.print("Send Docker Host List");

    return list;
}

/**
 * Send list of docker hosts to client
 * @param {Socket} socket Socket.io socket instance
 * @returns {Promise<Bean[]>} List of docker hosts
 */
async function sendRemoteBrowserList(socket) {
    const timeLogger = new TimeLogger();

    let result = [];
    let list = await R.find("remote_browser", " user_id = ? ", [socket.userID]);

    for (let bean of list) {
        result.push(bean.toJSON());
    }

    io.to(socket.userID).emit("remoteBrowserList", result);

    timeLogger.print("Send Remote Browser List");

    return list;
}

/**
 * Send list of monitor types to client
 * @param {Socket} socket Socket.io socket instance
 * @returns {Promise<void>}
 */
async function sendMonitorTypeList(socket) {
    const result = Object.entries(UptimeKumaServer.monitorTypeList).map(([key, type]) => {
        return [
            key,
            {
                supportsConditions: type.supportsConditions,
                conditionVariables: type.conditionVariables.map((v) => {
                    return {
                        id: v.id,
                        operators: v.operators.map((o) => {
                            return {
                                id: o.id,
                                caption: o.caption,
                            };
                        }),
                    };
                }),
            },
        ];
    });

    io.to(socket.userID).emit("monitorTypeList", Object.fromEntries(result));
}

module.exports = {
    sendNotificationList,
    sendImportantHeartbeatList,
    sendImportantHeartbeatsInitial,
    sendHeartbeatList,
    sendLastHeartbeatBatch,
    sendMonitorSummary,
    sendProxyList,
    sendAPIKeyList,
    sendInfo,
    sendDockerHostList,
    sendRemoteBrowserList,
    sendMonitorTypeList,
};
