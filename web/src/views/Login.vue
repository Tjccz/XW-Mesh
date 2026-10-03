<script setup>
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import api, { setToken } from '../api.js'

const router = useRouter()
const loading = ref(false)
const form = reactive({ username: 'admin', password: '' })

async function submit() {
  if (!form.username || !form.password) {
    ElMessage.warning('请输入用户名和密码')
    return
  }
  loading.value = true
  try {
    const { data } = await api.post('/auth/login', form)
    setToken(data.token)
    localStorage.setItem('xw_user', data.user.username)
    ElMessage.success('登录成功')
    router.push('/dashboard')
  } catch (e) {
    if (e.response?.status === 401) ElMessage.error('用户名或密码错误')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-panel">
      <section class="login-hero">
        <div class="hero-mark">湘</div>
        <h1>湘网组网</h1>
        <p class="hero-sub">XIANGWANG MESH CONSOLE</p>
        <p class="hero-desc">
          面向中小场景的异地组网与设备互联管理平台。<br />
          把分散在各处的设备，连成一张属于自己的内网。
        </p>
        <ul class="hero-points">
          <li><el-icon><Check /></el-icon> 设备一键接入，无需公网 IP</li>
          <li><el-icon><Check /></el-icon> 配置集中下发，变更可回滚</li>
          <li><el-icon><Check /></el-icon> 数据留在自己手里</li>
        </ul>
      </section>

      <section class="login-form">
        <h2>登录控制台</h2>
        <p class="form-hint">使用管理员账号登录</p>

        <el-form @submit.prevent="submit" label-position="top" size="large">
          <el-form-item label="用户名">
            <el-input v-model="form.username" placeholder="用户名" :prefix-icon="'User'" />
          </el-form-item>
          <el-form-item label="密码">
            <el-input
              v-model="form.password"
              type="password"
              placeholder="密码"
              show-password
              :prefix-icon="'Lock'"
              @keyup.enter="submit"
            />
          </el-form-item>
          <el-button
            type="primary"
            size="large"
            style="width: 100%; margin-top: 6px"
            :loading="loading"
            @click="submit"
          >
            登 录
          </el-button>
        </el-form>

        <p class="form-foot">
          首次部署的初始账号由服务端在启动时创建，请查看服务端日志。
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: radial-gradient(1200px 600px at 15% 10%, #163f49 0%, #0f2b33 45%, #0b2027 100%);
}

.login-panel {
  width: 100%;
  max-width: 940px;
  background: #fff;
  border-radius: 18px;
  overflow: hidden;
  display: grid;
  grid-template-columns: 1.05fr 1fr;
  box-shadow: 0 24px 60px rgba(6, 26, 32, 0.35);
}

.login-hero {
  padding: 44px 42px;
  background: linear-gradient(160deg, #0f2b33 0%, #12414c 55%, #0d9488 160%);
  color: #d7eae8;
}

.hero-mark {
  width: 46px;
  height: 46px;
  border-radius: 12px;
  background: #0d9488;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 22px;
}

.login-hero h1 {
  font-size: 26px;
  margin: 0 0 6px;
  color: #fff;
  letter-spacing: 2px;
}

.hero-sub {
  font-size: 11px;
  letter-spacing: 2px;
  color: #5f8f96;
  margin: 0 0 26px;
}

.hero-desc {
  font-size: 13.5px;
  line-height: 1.9;
  color: #b9d5d3;
  margin: 0 0 28px;
}

.hero-points {
  list-style: none;
  padding: 0;
  margin: 0;
  font-size: 13px;
  color: #cfe6e4;
}

.hero-points li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
}

.hero-points .el-icon {
  color: #2dd4bf;
}

.login-form {
  padding: 48px 46px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.login-form h2 {
  margin: 0 0 6px;
  font-size: 20px;
  color: #0f2b33;
}

.form-hint {
  font-size: 13px;
  color: #8b969b;
  margin: 0 0 26px;
}

.form-foot {
  margin-top: 22px;
  font-size: 12px;
  color: #a3adb2;
  line-height: 1.7;
}

@media (max-width: 820px) {
  .login-panel {
    grid-template-columns: 1fr;
    max-width: 460px;
  }
  .login-hero {
    padding: 30px 28px;
  }
  .hero-points {
    display: none;
  }
  .login-form {
    padding: 32px 28px;
  }
}
</style>
