export const rdStorage = {
  async get(keys) { 
    return browser.storage.local.get(keys); 
  },
  async set(data) { 
    return browser.storage.local.set(data); 
  },
  async remove(keys) { 
    return browser.storage.local.remove(keys); 
  },
  async getCachedDownloads() {
    const data = await this.get('rd_cached_downloads');
    return data.rd_cached_downloads || [];
  },
  async saveCachedDownloads(downloads) {
    return this.set({ rd_cached_downloads: downloads });
  },
  async getLocalDownloads() {
    const data = await this.get('rd_local_downloads');
    return data.rd_local_downloads || [];
  },
  async saveLocalDownloads(downloads) {
    return this.set({ rd_local_downloads: downloads });
  },
  async getLocalNotifications() {
    const data = await this.get('rd_local_notifications');
    return data.rd_local_notifications || [];
  },
  async saveLocalNotifications(notifications) {
    return this.set({ rd_local_notifications: notifications });
  }
};
