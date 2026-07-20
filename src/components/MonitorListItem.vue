<template>
    <div>
        <div
            class="draggable-item"
            :style="depthMargin"
            :class="{ 'drag-over': dragOverCount > 0 }"
            @dragstart="onDragStart"
            @dragenter.prevent="onDragEnter"
            @dragleave.prevent="onDragLeave"
            @dragover.prevent
            @drop.prevent="onDrop"
        >
            <!-- Checkbox -->
            <div v-if="isSelectMode" class="select-input-wrapper">
                <input
                    class="form-check-input select-input"
                    type="checkbox"
                    :aria-label="$t('Check/Uncheck')"
                    :checked="isSelected(monitor.id)"
                    @click.stop="toggleSelection"
                />
            </div>

            <router-link :to="monitorURL(monitor.id)" class="item" :class="{ disabled: !monitor.active }">
                <div class="row">
                    <div class="small-padding d-flex gap-2 align-items-center" :class="monitorStyle">
                        <div class="me-1">
                            <Uptime :monitor="monitor" type="24" :pill="true" />
                        </div>
                        <div class="d-flex align-items-center gap-2 flex-fill" style="min-width: 0">
                            <span v-if="hasChildren" class="collapse-padding" @click.prevent="changeCollapsed">
                                <font-awesome-icon
                                    icon="chevron-down"
                                    class="animated"
                                    :class="{ collapsed: isCollapsed }"
                                />
                            </span>
                            <div class="flex-fill text-truncate" style="min-width: 0">
                                <div class="text-truncate">{{ monitor.name }}</div>
                                <div v-if="monitor.tags.length > 0" class="tags gap-1">
                                    <Tag v-for="tag in monitor.tags" :key="tag" :item="tag" :size="'sm'" />
                                </div>
                            </div>
                        </div>
                    </div>
                    <div
                        v-show="$root.userHeartbeatBar == 'normal'"
                        :key="$root.userHeartbeatBar"
                        class="col-3 col-xl-6"
                    >
                        <HeartbeatBar ref="heartbeatBar" size="small" :monitor-id="monitor.id" />
                    </div>
                </div>

                <div v-if="$root.userHeartbeatBar == 'bottom'" class="row">
                    <div class="col-12 bottom-style">
                        <HeartbeatBar ref="heartbeatBar" size="small" :monitor-id="monitor.id" />
                    </div>
                </div>
            </router-link>
        </div>

        <transition name="slide-fade-up">
            <div v-if="!isCollapsed" class="childs">
                <div v-if="loadingChildren" class="text-center py-2 text-secondary">
                    <font-awesome-icon icon="spinner" spin />
                    <span class="ms-2">{{ $t("Loading...") }}</span>
                </div>
                <template v-else>
                    <MonitorListItem
                        v-for="(item, index) in sortedChildMonitorList"
                        :key="index"
                        :monitor="item"
                        :isSelectMode="isSelectMode"
                        :isSelected="isSelected"
                        :select="select"
                        :deselect="deselect"
                        :depth="depth + 1"
                        :filter-func="filterFunc"
                        :sort-func="sortFunc"
                    />
                </template>
            </div>
        </transition>
    </div>
</template>

<script>
import HeartbeatBar from "../components/HeartbeatBar.vue";
import Tag from "../components/Tag.vue";
import Uptime from "../components/Uptime.vue";
import { getMonitorRelativeURL } from "../util.ts";

export default {
    name: "MonitorListItem",
    components: {
        Uptime,
        HeartbeatBar,
        Tag,
    },
    props: {
        /** Monitor this represents */
        monitor: {
            type: Object,
            default: null,
        },
        /** If the user is in select mode */
        isSelectMode: {
            type: Boolean,
            default: false,
        },
        /** How many ancestors are above this monitor */
        depth: {
            type: Number,
            default: 0,
        },
        /** Callback to determine if monitor is selected */
        isSelected: {
            type: Function,
            default: () => {},
        },
        /** Callback fired when monitor is selected */
        select: {
            type: Function,
            default: () => {},
        },
        /** Callback fired when monitor is deselected */
        deselect: {
            type: Function,
            default: () => {},
        },
        /** Function to filter child monitors */
        filterFunc: {
            type: Function,
            default: () => {},
        },
        /** Function to sort child monitors */
        sortFunc: {
            type: Function,
            default: () => {},
        },
    },
    data() {
        return {
            isCollapsed: true,
            dragOverCount: 0,
            loadingChildren: false,
            isAlive: true,
        };
    },
    computed: {
        sortedChildMonitorList() {
            let result = Object.values(this.$root.monitorList);

            // Get children
            result = result.filter((childMonitor) => childMonitor.parent === this.monitor.id);

            // Run filter on children
            result = result.filter(this.filterFunc);

            result.sort(this.sortFunc);

            return result;
        },
        hasChildren() {
            return this.sortedChildMonitorList.length > 0;
        },
        depthMargin() {
            return {
                marginLeft: `${20 * this.depth}px`,
            };
        },
        monitorStyle() {
            const isFullWidth = this.$root.userHeartbeatBar === "bottom" || this.$root.userHeartbeatBar === "none";
            const c = {};
            if (!isFullWidth) {
                c["col-9"] = true;
                c["col-xl-6"] = true;
            }
            return c;
        },
    },
    watch: {
        isSelectMode() {
            // TODO: Resize the heartbeat bar, but too slow
            // this.$refs.heartbeatBar.resize();
        },
    },
    beforeMount() {
        // Always unfold if monitor is accessed directly
        if (this.monitor.childrenIDs.includes(parseInt(this.$route.params.id))) {
            this.isCollapsed = false;
            return;
        }

        // Set collapsed value based on local storage
        let storage = window.localStorage.getItem("monitorCollapsed");
        if (storage === null) {
            return;
        }

        let storageObject = JSON.parse(storage);
        if (storageObject[`monitor_${this.monitor.id}`] == null) {
            return;
        }

        this.isCollapsed = storageObject[`monitor_${this.monitor.id}`];
    },
    mounted() {
        // If the group is initially expanded (e.g. from localStorage or deep-link),
        // load its children now. changeCollapsed handles the user-toggle case.
        if (!this.isCollapsed && this.monitor.type === "group" && !this.isChildrenLoaded() && !this.loadingChildren) {
            this.loadChildren();
        }
    },
    beforeUnmount() {
        this.isAlive = false;
    },
    methods: {
        /**
         * Whether this group's children have already been fetched.
         * Tracked on $root so it survives DynamicScroller recycling.
         * @returns {boolean} True if children are already loaded
         */
        isChildrenLoaded() {
            return this.$root.loadedGroupChildren.has(this.monitor.id);
        },
        /**
         * Changes the collapsed value of the current monitor and saves
         * it to local storage. When expanding a group, lazily loads its
         * children on first expand.
         * @returns {void}
         */
        changeCollapsed() {
            this.isCollapsed = !this.isCollapsed;

            // Save collapsed value into local storage
            let storage = window.localStorage.getItem("monitorCollapsed");
            let storageObject = {};
            if (storage !== null) {
                storageObject = JSON.parse(storage);
            }
            storageObject[`monitor_${this.monitor.id}`] = this.isCollapsed;

            window.localStorage.setItem("monitorCollapsed", JSON.stringify(storageObject));

            // Lazily load children on first expand of a group.
            if (!this.isCollapsed && this.monitor.type === "group" && !this.isChildrenLoaded() && !this.loadingChildren) {
                this.loadChildren();
            }
        },
        /**
         * Fetch direct children of this group monitor and merge them into
         * the root monitorList. Subscription and the loaded-children flag
         * are updated inside `getMonitorChildren`. Idempotent: a second
         * call before the first completes is a no-op thanks to
         * `loadingChildren` and `isChildrenLoaded`.
         * @returns {void}
         */
        loadChildren() {
            this.loadingChildren = true;
            this.$root.getMonitorChildren(this.monitor.id, (res) => {
                if (!this.isAlive) {
                    return;
                }
                this.loadingChildren = false;
            });
        },
        /**
         * Initializes the drag operation if the monitor is draggable.
         * @param {DragEvent} event - The dragstart event triggered by the browser.
         * @returns {void} This method does not return anything.
         */
        onDragStart(event) {
            try {
                event.dataTransfer.setData("text/monitor-id", String(this.monitor.id));
                event.dataTransfer.effectAllowed = "move";
            } catch (e) {
                // ignore
            }
        },

        onDragEnter(event) {
            if (this.monitor.type !== "group") {
                return;
            }

            this.dragOverCount++;
        },

        onDragLeave(event) {
            if (this.monitor.type !== "group") {
                return;
            }

            this.dragOverCount = Math.max(0, this.dragOverCount - 1);
        },

        async onDrop(event) {
            this.dragOverCount = 0;

            // Only groups accept drops
            if (this.monitor.type !== "group") {
                return;
            }

            const draggedId = event.dataTransfer.getData("text/monitor-id");
            if (!draggedId) {
                return;
            }

            const draggedMonitorId = parseInt(draggedId);
            if (isNaN(draggedMonitorId) || draggedMonitorId === this.monitor.id) {
                return;
            }

            const draggedMonitor = this.$root.monitorList[draggedMonitorId];
            if (!draggedMonitor) {
                return;
            }

            // Save original parent so we can revert locally if server returns error
            const originalParent = draggedMonitor.parent;

            // Prepare a full monitor object (clone) and set new parent
            const monitorToSave = JSON.parse(JSON.stringify(draggedMonitor));
            monitorToSave.parent = this.monitor.id;

            // Optimistically update local state so UI updates immediately
            this.$root.monitorList[draggedMonitorId].parent = this.monitor.id;

            // Send updated monitor state via socket
            try {
                this.$root.getSocket().emit("editMonitor", monitorToSave, (res) => {
                    if (!res || !res.ok) {
                        // Revert local change on error
                        if (this.$root.monitorList[draggedMonitorId]) {
                            this.$root.monitorList[draggedMonitorId].parent = originalParent;
                        }
                        if (res && res.msg) {
                            this.$root.toastError(res.msg);
                        }
                    } else {
                        this.$root.toastRes(res);
                    }
                });
            } catch (e) {
                // revert on exception
                if (this.$root.monitorList[draggedMonitorId]) {
                    this.$root.monitorList[draggedMonitorId].parent = originalParent;
                }
            }
        },
        /**
         * Get URL of monitor
         * @param {number} id ID of monitor
         * @returns {string} Relative URL of monitor
         */
        monitorURL(id) {
            return getMonitorRelativeURL(id);
        },
        /**
         * Toggle selection of monitor
         * @returns {void}
         */
        toggleSelection() {
            if (this.isSelected(this.monitor.id)) {
                this.deselect(this.monitor.id);
            } else {
                this.select(this.monitor.id);
            }
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.small-padding {
    padding-left: 5px !important;
    padding-right: 5px !important;
}

.tags {
    margin-top: 4px;
    padding-left: 4px;
    display: flex;
    flex-wrap: wrap;
    gap: 0;
}

.collapsed {
    transform: rotate(-90deg);
}

.animated {
    transition: all 0.2s $easing-in;
}

.select-input-wrapper {
    float: left;
    margin-top: 15px;
    margin-left: 3px;
    margin-right: 10px;
    padding-left: 4px;
    position: relative;
    z-index: 15;
}

.drag-over {
    border: 4px dashed $primary;
    border-radius: 0.5rem;
    background-color: $highlight-white;
}

.dark {
    .drag-over {
        background-color: $dark-bg2;
    }
}

/* -4px on all due to border-width */
.monitor-list .drag-over .item {
    padding: 9px 11px 6px 11px;
}

.draggable-item {
    cursor: grab;
    position: relative;

    /* We don't want the padding change due to the border animated */
    .item {
        padding: 12px 15px;
        transition: none !important;
    }

    &.dragging {
        cursor: grabbing;
    }
}

.bottom-style {
    margin-left: -10px;
    margin-top: 5px;
}
</style>
