import Obsidian from "obsidian";
const {
  addIcon,
  Keymap,
  MarkdownRenderer,
  Notice,
  Plugin,
  request,
  requestUrl,
  TAbstractFile,
  TFile,
} = Obsidian;
import { SmartEnv } from 'smart-environment';
import { smart_env_config } from "./smart_env.config.js";
import { default_settings } from "./default_settings.js";
import ejs from "../ejs.min.cjs";
import templates from "../build/views.json" assert { type: "json" };
// rename modules
import { ScSmartView } from "./sc_smart_view.js";
import { SmartSearch } from "./smart_search.js";
// v2.1
import { ScChatView } from "./chat/sc_chat_view.js";
import { ScSettingsTab } from "./sc_settings_tab.js";
import { ScActionsUx } from "./sc_actions_ux.js";
import { open_note } from "./open_note.js";
import { SmartChatGPTView } from "./sc_chatgpt_view.js";
import { SmartPrivateChatView } from "./sc_private_chat_view.js";
import { ScChatModel } from "./chat/sc_chat_model.js";
import { ScChatsUI } from "./chat/sc_chats_ui.js";
import { ScChats } from "./chat/sc_chats.js";
import { ScActions } from "./sc_actions.js";
import { ScAppConnector } from "./sc_app_connector.js";

export default class SmartConnectionsPlugin extends Plugin {
  static get defaults() { return default_settings() }
  get item_views() {
    return {
      ScSmartView,
      ScChatView,
      SmartChatGPTView,
      SmartPrivateChatView,
    }
  }
  // GETTERS for overrides in subclasses without overriding the constructor or init method
  get smart_env_class() { return SmartEnv; }
  get smart_env_config() {
    const config = {
      ...smart_env_config,
      env_path: '', // scope handled by Obsidian FS methods
      // DEPRECATED schema
      smart_env_settings: { // careful: overrides saved settings
        is_obsidian_vault: true,
      },
      // DEPRECATED usage
      ejs: ejs,
      templates: templates,
      request_adapter: this.obsidian.requestUrl, // NEEDS BETTER HANDLING
      chat_classes: this.chat_classes,
    };
    // mobile enable/disable
    if(this.obsidian.Platform.isMobile && !this.settings.enable_mobile) config.prevent_load_on_init = true;
    return config;
  }
  get chat_classes() { return { ScActions, ScChatsUI, ScChats, ScChatModel }; }
  get_tfile(file_path) { return this.app.vault.getAbstractFileByPath(file_path); }
  async read_file(tfile_or_path) {
    const t_file = (typeof tfile_or_path === 'string') ? this.get_tfile(tfile_or_path) : tfile_or_path; // handle string (file_path) or Tfile input
    if (!(t_file instanceof this.obsidian.TFile)) return null;
    return await this.app.vault.cachedRead(t_file);
  }
  get api() { return this._api; }
  async onload() { this.app.workspace.onLayoutReady(this.initialize.bind(this)); } // initialize when layout is ready
  onunload() {
    console.log("unloading plugin");
    this.env?.unload_main('smart_connections_plugin');
    this.env = null;
    this.notices?.unload();
  }
  async initialize() {
    this.obsidian = Obsidian;
    await this.load_settings();
    this.notices = new this.smart_env_config.modules.smart_notices.class(this);
    console.log("Loading Smart Connections v2...");
    this.smart_connections_view = null;
    this.add_commands(); // add commands
    this.register_views(); // register chat view type
    this.addSettingTab(new ScSettingsTab(this.app, this)); // add settings tab
    await this.check_for_updates();
    this._api = new SmartSearch(this);
    (window["SmartSearch"] = this._api) && this.register(() => delete window["SmartSearch"]); // register API to global window object
    this.addRibbonIcon("smart-connections", "Open: View Smart Connections", () => { this.open_view(); });
    this.addRibbonIcon("message-square", "Open: Smart Chat Conversation", () => { this.open_chat(); });
    this.register_code_blocks();
    this.new_user();
    console.log("loading env");
    await this.load_env();
    console.log("Smart Connections v2 loaded");
    // run init chat last because buggy (seems to not finish resolving)
    this.init_chat_model();
    await this.init_chat();
  }
  register_code_blocks() {
    this.register_code_block("smart-connections", "render_code_block"); // code-block renderer
    this.register_code_block("sc-context", "render_code_block_context"); // code-block renderer
    // "AI change" dynamic code block
    this.register_code_block("sc-change", "change_code_block"); // DEPRECATED
    this.register_code_block("smart-change", "change_code_block");
  }
  register_code_block(name, callback_name) {
    try{
      this.registerMarkdownCodeBlockProcessor(name, this[callback_name].bind(this));
    } catch (error) {
      console.warn(`Error registering code block: ${name}`, error);
    }
  }

  async load_env() {
    // if(this.obsidian.Platform.isMobile && !this.settings.enable_mobile) return console.warn("SKIPPING: Mobile and not enabled"); // SKIP if mobile and not enabled
    await this.smart_env_class.create(this, this.smart_env_config);
    console.log("env loaded");
    ScAppConnector.create(this.env, 37042); // Smart Connect
    // DEPRECATED getters: for Smart Visualizer backwards compatibility
    Object.defineProperty(this.env, 'entities_loaded', { get: () => this.env.collections_loaded });
    Object.defineProperty(this.env, 'smart_notes', { get: () => this.env.smart_sources });
  }
  async ready_to_load_collections() {
    await new Promise(r => setTimeout(r, 5000)); // wait 5 seconds for other processes to finish
    await this.wait_for_obsidian_sync();
  }

  init_chat_model(chat_model_platform_key=null) {
    let chat_model_config = {};
    chat_model_platform_key = chat_model_platform_key ?? this.settings.chat_model_platform_key;
    if(chat_model_platform_key === 'open_router' && !this.settings[chat_model_platform_key]?.api_key) chat_model_config.api_key = process.env.DEFAULT_OPEN_ROUTER_API_KEY;
    else chat_model_config = this.settings[chat_model_platform_key] ?? {};
    this.env.chat_model = new this.chat_classes.ScChatModel(this.env, chat_model_platform_key, {...chat_model_config });
    this.env.chat_model._request_adapter = this.obsidian.requestUrl;
  }

  async init_chat(){
    this.env.actions = new this.chat_classes.ScActions(this.env);
    this.env.actions.init();
    // wait for chat_view containerEl to be available
    while (!this.chat_view?.containerEl) await new Promise(r => setTimeout(r, 300));
    this.env.chat_ui = new this.chat_classes.ScChatsUI(this.env, this.chat_view.container);
    this.env.chats = new this.chat_classes.ScChats(this.env);
    await this.env.chats.load_all();
  }

  new_user() {
    if(!this.settings.new_user) return;
    this.settings.new_user = false;
    this.settings.version = this.manifest.version;
    setTimeout(() => {
      this.open_view();
      this.open_chat();
    }, 1000); // wait a sec to allow existing views to open
    if(this.app.workspace.rightSplit.collapsed) this.app.workspace.rightSplit.toggle();
    this.add_to_gitignore("\n\n# Ignore Smart Environment folder\n.smart-env"); 
    this.save_settings();
  }
  register_views() {
    this.obsidian.addIcon("smart-connections", `<path d="M50,20 L80,40 L80,60 L50,100" stroke="currentColor" stroke-width="4" fill="none"/>
    <path d="M30,50 L55,70" stroke="currentColor" stroke-width="5" fill="none"/>
    <circle cx="50" cy="20" r="9" fill="currentColor"/>
    <circle cx="80" cy="40" r="9" fill="currentColor"/>
    <circle cx="80" cy="70" r="9" fill="currentColor"/>
    <circle cx="50" cy="100" r="9" fill="currentColor"/>
    <circle cx="30" cy="50" r="9" fill="currentColor"/>`);
    Object.values(this.item_views).forEach(View => {
      this.registerView(View.view_type, (leaf) => (new View(leaf, this)));
    });
  }
  async check_for_updates() {
    if(this.settings.version !== this.manifest.version){
      this.settings.version = this.manifest.version; // update version
      await this.save_settings(); // save settings
    }
    setTimeout(this.check_for_update.bind(this), 3000); // run after 3 seconds
    setInterval(this.check_for_update.bind(this), 10800000); // run check for update every 3 hours
  }
  // check for update
  async check_for_update() {
    // fail silently, ex. if no internet connection
    try {
      // get latest release version from github
      const {json: response} = await requestUrl({
        url: "https://api.github.com/repos/brianpetro/obsidian-smart-connections/releases/latest",
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
        contentType: "application/json",
      });
      // get version number from response
      const latest_release = response.tag_name;
      // console.log(`Latest release: ${latest_release}`);
      // if latest_release is newer than current version, show message
      if(latest_release !== this.manifest.version) {
        new Notice(`[Smart Connections] A new version is available! (v${latest_release})`);
        this.update_available = true;
      }
    } catch (error) {
      console.log(error);
    }
  }
  async restart_plugin() {
    await this.saveData(this.settings); // save settings
    await new Promise(r => setTimeout(r, 3000));
    window.restart_plugin = async (id) => {
      console.log("restarting plugin", id);
      await window.app.plugins.disablePlugin(id);
      await window.app.plugins.enablePlugin(id);
      console.log("plugin restarted", id);
    };
    await window.restart_plugin(this.manifest.id);
  }

  add_commands() {
    // make connections command
    this.addCommand({
      id: "sc-find-notes",
      name: "Find: Make Smart Connections",
      icon: "pencil_icon",
      hotkeys: [],
      editorCallback: (editor) => {
        if(editor.somethingSelected()) this.view.render_nearest(editor.getSelection());
        else if(editor.getCursor()?.line){ // if cursor is on a line greater than 0
          const line = editor.getCursor().line;
          const block = this.env.smart_sources.current_note.get_block_by_line(line);
          this.view.render_nearest(block);
        }
        else this.view.render_nearest();
      }
    });
    // make connections command
    this.addCommand({
      id: "sc-refresh-connections",
      name: "Refresh & Make Connections",
      icon: "pencil_icon",
      hotkeys: [],
      editorCallback: async (editor) => {
        // get current note
        const curr_file = this.app.workspace.getActiveFile();
        if(!curr_file?.path) return console.warn("No active file", curr_file);
        // delete note entity from cache
        if(this.env?.connections_cache?.[curr_file.path]) delete this.env.connections_cache[curr_file.path];
        // delte note entity from collection
        this.env.smart_sources.delete_item(curr_file.path);
        // import note
        await this.env.smart_sources.import_file(curr_file);
        setTimeout(() => {
          // refresh view
          this.view.render_nearest();
        }, 1000);
      }
    });
    // open view command
    this.addCommand({
      id: "smart-connections-view",
      name: "Open: View Smart Connections",
      callback: () => { this.open_view(); }
    });
    // open chat command
    this.addCommand({
      id: "smart-connections-chat",
      name: "Open: Smart Chat Conversation",
      callback: () => { this.open_chat(); }
    });
    // open random note from nearest cache
    this.addCommand({
      id: "smart-connections-random",
      name: "Random Note",
      callback: () => {
        const curr_file = this.app.workspace.getActiveFile();
        const entity = this.env.smart_sources.get(curr_file.path);
        const connections = entity.find_connections({
            key: curr_file.path,
            limit: 20,
          })
        ;
        const rand = Math.floor(Math.random() * connections.length/2); // divide by 2 to limit to top half of results
        const rand_entity = connections[rand]; // get random from nearest cache
        this.open_note(rand_entity.path);
      }
    });
    // open chat command
    this.addCommand({
      id: "smart-connections-chatgpt",
      name: "Open: Smart ChatGPT",
      callback: () => { this.open_chatgpt(); }
    });
    // open private chat command
    this.addCommand({
      id: "smart-connections-private-chat",
      name: "Open: Smart Connections Supporter Private Chat",
      callback: () => { this.open_private_chat(); }
    });
  }
  async make_connections(selected_text=null) {
    if(!this.view) await this.open_view(); // open view if not open
    await this.view.render_nearest(selected_text);
  }
  // utils
  async add_to_gitignore(ignore, message=null) {
    if(!(await this.app.vault.adapter.exists(".gitignore"))) return; // if .gitignore skip
    let gitignore_file = await this.app.vault.adapter.read(".gitignore");
    if (gitignore_file.indexOf(ignore) < 0) {
      await this.app.vault.adapter.append(".gitignore", `\n\n${message ? "# " + message + "\n" : ""}${ignore}`);
      console.log("Added to .gitignore: " + ignore);
    }
  }
  show_notice(message, opts={}) {
    console.log("old showing notice");
    const notice_id = typeof message === 'string' ? message : message[0];
    return this.notices.show(notice_id, message, opts);
  }
  get chat_view() { return ScChatView.get_view(this.app.workspace); }
  open_chat() { ScChatView.open(this.app.workspace); }
  get view() { return ScSmartView.get_view(this.app.workspace); } 
  open_view(active=true) { ScSmartView.open(this.app.workspace, active); }

  open_chatgpt() { SmartChatGPTView.open(this.app.workspace); }
  open_private_chat() { SmartPrivateChatView.open(this.app.workspace); }
  async open_note(target_path, event=null) { await open_note(this, target_path, event); }
  // get folders, traverse non-hidden sub-folders
  async get_folders(path = "/") {
    try {
      const folders = (await this.app.vault.adapter.list(path)).folders;
      let folder_list = [];
      for (let i = 0; i < folders.length; i++) {
        if (folders[i].startsWith(".")) continue;
        folder_list.push(folders[i]);
        folder_list = folder_list.concat(await this.get_folders(folders[i] + "/"));
      }
      return folder_list;
    } catch (error) {
      console.warn("Error getting folders", error);
      return [];
    }
  }
  get_link_target_path(link_path, file_path) {
    return this.app.metadataCache.getFirstLinkpathDest(link_path, file_path)?.path;
  }
  // SUPPORTERS
  async render_code_block(contents, container, ctx) {
    return this.view.render_nearest((contents.trim().length? contents : ctx.sourcePath), container);
  }
  async render_code_block_context(results, container, ctx) {
    results = this.get_entities_from_context_codeblock(results);
    container.innerHTML = this.view.render_template("smart_connections", { current_path: "context", results });
    container.querySelectorAll(".search-result").forEach((elm, i) => this.view.add_link_listeners(elm, results[i]));
    container.querySelectorAll(".search-result:not(.sc-collapsed) ul li").forEach(this.view.render_result.bind(this.view));
  }
  get_entities_from_context_codeblock(results) {
    return results.split("\n").map(key => {
      // const key = line.substring(line.indexOf('[[') + 2, line.indexOf(']]'));
      const entity = key.includes("#") ? this.env.smart_blocks.get(key) : this.env.smart_sources.get(key);
      return entity ? entity : { name: "Not found: " + key };
    });
  }
  // change code block
  async change_code_block(source, el, ctx) {
    const el_class = el.classList[0];
    const codeblock_type = el_class.replace("block-language-", "");
    const renderer = new ScActionsUx(this, el, codeblock_type);
    renderer.change_code_block(source);
  }
  
  async update_early_access() {
    // // if license key is not set, return
    if(!this.settings.license_key) return this.show_notice("Supporter license key required for early access update");
    const v2 = await this.obsidian.requestUrl({
      url: "https://sync.smartconnections.app/download_v2",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        license_key: this.settings.license_key,
      })
    });
    if(v2.status !== 200) return console.error("Error downloading early access update", v2);
    await this.app.vault.adapter.write(".obsidian/plugins/smart-connections/main.js", v2.json.main); // add new
    await this.app.vault.adapter.write(".obsidian/plugins/smart-connections/manifest.json", v2.json.manifest); // add new
    await this.app.vault.adapter.write(".obsidian/plugins/smart-connections/styles.css", v2.json.styles); // add new
    await window.app.plugins.loadManifests();
    await this.restart_plugin();
  }

  get plugin_is_enabled() { return this.app?.plugins?.enabledPlugins?.has("smart-connections"); }
  // WAIT FOR OBSIDIAN SYNC
  async wait_for_obsidian_sync() {
    while (this.obsidian_is_syncing) {
      if(!this.plugin_is_enabled) throw new Error("Smart Connections: plugin disabled while waiting for obsidian sync"); // if plugin is disabled, stop waiting for sync
      console.log("Smart Connections: Waiting for Obsidian Sync to finish");
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  get obsidian_is_syncing() {
    const obsidian_sync_instance = this.app?.internalPlugins?.plugins?.sync?.instance;
    if(!obsidian_sync_instance) return false; // if no obsidian sync instance, not syncing
    if(obsidian_sync_instance?.syncStatus.startsWith('Uploading')) return false; // if uploading, don't wait for obsidian sync
    if(obsidian_sync_instance?.syncStatus.startsWith('Fully synced')) return false; // if fully synced, don't wait for obsidian sync
    return obsidian_sync_instance?.syncing;
  }

  // main settings
  async load_settings() {
    Object.assign(this, this.constructor.defaults); // set defaults
    const saved_settings = await this.loadData();
    Object.assign(this.settings, saved_settings || {}); // overwrites defaults with saved settings
    return this.settings;
  }
  async save_settings(settings=this.settings) {
    await this.saveData(settings); // Obsidian API->saveData
  }
  
  get system_prompts() {
    return this.app.vault.getMarkdownFiles()
      .filter(file => file.path.includes(this.settings.system_prompts_folder) || file.path.includes('.prompt') || file.path.includes('.sp'))
    ;
  }

  // FROM ScSettings
  async force_refresh() {
    this.env.smart_blocks.clear();
    this.env.smart_sources.clear();
    await this.env.smart_sources.init(); // trigger making new connections
    Object.values(this.env.smart_sources.items).forEach(item => item.queue_import());
    await this.env.smart_sources.process_import_queue(); // trigger making new connections
  }
  async exclude_all_top_level_folders() {
    const folders = (await this.app.vault.adapter.list("/")).folders;
    const input = document.querySelector("#smart-connections-settings div[data-setting='folder_exclusions'] input");
    input.value = folders.join(", ");
    input.dispatchEvent(new Event("input")); // send update event
    this.update_exclusions();
  }
  async update_exclusions() {
    this.env.smart_sources.smart_fs = null; // clear smart fs cache (re adds exclusions) (should only require clearing smart_sources.smart_fs)
    console.log("render_file_counts");
    const elm = document.querySelector("#smart-connections-settings #file-counts");
    elm.setText(`Included files: ${this.included_files} / Total files: ${this.total_files}`);
  }
  // get included files count
  get included_files() {
    return this.app.vault.getFiles()
      .filter((file) => {
        if(!(file instanceof this.obsidian.TFile) || !(file.extension === "md" || file.extension === "canvas")) return false;
        if(this.env.fs.is_excluded(file.path)) return false;
        return true;
      })
      .length
    ;
  }
  // get all files count, no exclusions
  get total_files() {
    return this.app.vault.getFiles()
      .filter((file) => (file instanceof this.obsidian.TFile) && (file.extension === "md" || file.extension === "canvas"))
      .length
    ;
  }
  async toggle_mobile(setting, value, elm) {
    const manifest = JSON.parse(await this.app.vault.adapter.read(".obsidian/plugins/smart-connections/manifest.json"));
    manifest.isDesktopOnly = !value;
    await this.app.vault.adapter.write(".obsidian/plugins/smart-connections/manifest.json", JSON.stringify(manifest, null, 2));
    console.log("Manifest written");
    this.restart_plugin();
  }

}