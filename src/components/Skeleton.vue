<template>
    <div class="skeleton" :class="{ 'skeleton-block': block }" :style="customStyle"></div>
</template>

<script>
export default {
    name: "Skeleton",
    props: {
        width: {
            type: String,
            default: "100%",
        },
        height: {
            type: String,
            default: "16px",
        },
        block: {
            type: Boolean,
            default: false,
        },
    },
    computed: {
        customStyle() {
            return {
                width: this.width,
                height: this.block ? "100%" : this.height,
            };
        },
    },
};
</script>

<style lang="scss" scoped>
.skeleton {
    background: linear-gradient(90deg,
        rgba(220, 220, 220, 0.4) 25%,
        rgba(200, 200, 200, 0.6) 37%,
        rgba(220, 220, 220, 0.4) 63%);
    background-size: 400% 100%;
    animation: skeleton-shimmer 1.4s ease infinite;
    border-radius: 4px;
}

.skeleton-block {
    display: block;
}

@keyframes skeleton-shimmer {
    0% {
        background-position: 100% 50%;
    }
    100% {
        background-position: 0 50%;
    }
}
</style>
