import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { t, useLocale } from './i18n';
import { providerTasks, type TaskPhase, type TaskErrorCode } from './providerTasks';
import { providerCapabilities, providerFailureStatus, releaseLocalResources } from './providers';
import type { ProviderFeature } from './providerSettings';
import './taskCenter.css';
import { getModelIdleSeconds, setModelIdleSeconds, validModelIdleSeconds } from './modelIdle';

const features: Record<ProviderFeature, string> = {
  translation: '翻译',
  formula: '公式识别',
  ocr: '文字 OCR',
  speech: '朗读',
};
const phases: Record<TaskPhase, string> = {
  queued: '排队中',
  running: '运行中',
  fallback: '回退中',
  cancelling: '正在取消',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
};
const errors: Record<TaskErrorCode, string> = {
  cancelled: '已取消',
  timeout: '任务超时',
  busy: '后端忙碌',
  'invalid-input': '输入或配置无效',
  'missing-model': '本地模型未安装',
  unavailable: '后端不可用',
};
const active = (phase: TaskPhase) => !['completed', 'cancelled', 'failed'].includes(phase);
export default function TaskCenter({ onClose }: { onClose: () => void }) {
  const [idleSeconds, setIdleSeconds] = useState(getModelIdleSeconds),
    [idleSaved, setIdleSaved] = useState(false);
  const locale = useLocale(),
    tasks = useSyncExternalStore(providerTasks.subscribe, providerTasks.getSnapshot);
  const releaseController = useRef<AbortController | null>(null),
    [releasing, setReleasing] = useState(false),
    [releaseStatus, setReleaseStatus] = useState('');
  useEffect(
    () => () => {
      releaseController.current?.abort();
    },
    [],
  );
  async function releaseMemory() {
    if (releaseController.current) return;
    const controller = new AbortController();
    releaseController.current = controller;
    setReleasing(true);
    setReleaseStatus(t('等待本地任务完成后释放闲置模型…'));
    try {
      const state = await releaseLocalResources(controller.signal);
      if (!controller.signal.aborted)
        setReleaseStatus(
          t(
            state === 'unsupported'
              ? '浏览器闲置模型已释放；旧原生服务仍按闲置策略释放，请更新本地服务。'
              : state === 'unavailable'
                ? '浏览器闲置模型已释放；原生服务未响应。'
                : '闲置模型已释放，再次使用时按需加载。',
          ),
        );
    } catch (error) {
      if (!controller.signal.aborted) setReleaseStatus(providerFailureStatus(error));
    } finally {
      if (releaseController.current === controller) releaseController.current = null;
      if (!controller.signal.aborted) setReleasing(false);
    }
  }
  const capabilities = providerCapabilities();
  return (
    <div className="modal-scrim task-scrim">
      <section
        className="modal task-center"
        role="dialog"
        aria-modal="true"
        aria-label={t('任务与后端')}
      >
        <header>
          <div>
            <h2>{t('任务与后端')}</h2>
            <p>{t('本地推理顺序执行；远程请求最多并行两路。')}</p>
          </div>
          <button className="icon-button" aria-label={t('关闭任务面板')} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="task-center-body">
          <p className="muted">
            {t('仅保留本次会话最近 20 项任务的状态；不记录选区、图片、结果、地址或凭据。')}
          </p>
          <div className="task-center-actions">
            <button
              disabled={!tasks.some((job) => !active(job.phase))}
              onClick={providerTasks.clear}
            >
              {t('清除已结束任务')}
            </button>
            <span>{t('{0} 项任务进行中', tasks.filter((job) => active(job.phase)).length)}</span>
          </div>
          <div className="task-memory">
            <label className="model-idle-setting">
              {t('模型闲置卸载时间（秒）')}
              <input
                type="number"
                min={30}
                max={86400}
                step={1}
                aria-label={t('模型闲置卸载时间（秒）')}
                value={idleSeconds}
                onChange={(event) => {
                  setIdleSeconds(Number(event.target.value));
                  setIdleSaved(false);
                }}
              />
              <button
                disabled={!validModelIdleSeconds(idleSeconds)}
                onClick={() => {
                  setModelIdleSeconds(idleSeconds);
                  setIdleSaved(true);
                }}
              >
                {t('保存闲置设置')}
              </button>
            </label>
            <p className="muted">
              {t(
                '默认 1800 秒（30 分钟），范围 30–86400 秒；从任务结束开始计时，保留模型文件与编译缓存。',
              )}
            </p>
            {idleSaved && <p role="status">{t('闲置设置已保存；本地服务下次推理时也会应用。')}</p>}
            <button disabled={releasing} onClick={() => void releaseMemory()}>
              {t(releasing ? '正在释放…' : '释放闲置模型内存')}
            </button>
            <p className="muted">{t('仅释放内存中的模型，保留文档、模型文件与磁盘缓存。')}</p>
            {releaseStatus && (
              <p className="muted" role="status">
                {releaseStatus}
              </p>
            )}
          </div>
          {!tasks.length && (
            <p className="task-empty">
              {t('暂无任务。执行翻译、公式、OCR、朗读或连接检查后会在这里显示。')}
            </p>
          )}
          <div className="task-list">
            {tasks.map((job) => (
              <article
                className="task-card"
                key={job.id}
                data-task-id={job.id}
                data-phase={job.phase}
              >
                <div className="task-card-heading">
                  <strong>
                    {t(features[job.feature])}
                    {job.operation === 'check' ? ` · ${t('连接检查')}` : ''}
                  </strong>
                  <span role="status">{t(phases[job.phase])}</span>
                  {active(job.phase) && (
                    <button
                      disabled={job.phase === 'cancelling'}
                      aria-label={t('取消任务 {0}', t(features[job.feature]))}
                      onClick={() => providerTasks.cancel(job.id)}
                    >
                      {t('取消任务')}
                    </button>
                  )}
                </div>
                <dl>
                  <dt>{t('请求后端')}</dt>
                  <dd>{job.requested}</dd>
                  <dt>{t(job.phase === 'completed' ? '实际后端' : '当前尝试')}</dt>
                  <dd>
                    {job.attempt || !job.endedAt ? job.provider : t('未执行')}{' '}
                    {job.fallback && <span className="task-fallback">{t('已回退')}</span>}
                  </dd>
                  <dt>{t('模型')}</dt>
                  <dd>{job.modelId || '—'}</dd>
                  <dt>{t('实际设备')}</dt>
                  <dd>
                    {!job.device || job.device === 'pending'
                      ? t(job.endedAt ? (job.attempt ? '未报告' : '未执行') : '等待执行')
                      : job.device}
                  </dd>
                  <dt>{t('开始时间')}</dt>
                  <dd>{new Date(job.startedAt).toLocaleTimeString(locale)}</dd>
                  <dt>{t('任务总耗时')}</dt>
                  <dd>
                    {job.endedAt ? t('{0} 秒', (job.elapsed / 1000).toFixed(2)) : t('处理中')}
                  </dd>
                  {job.workElapsed !== undefined && (
                    <>
                      <dt>{t('后端报告耗时')}</dt>
                      <dd>{t('{0} 秒', (job.workElapsed / 1000).toFixed(2))}</dd>
                    </>
                  )}
                  <dt>{t('尝试次数')}</dt>
                  <dd>{job.attempt}</dd>
                  {job.error && (
                    <>
                      <dt>{t('错误类型')}</dt>
                      <dd className="task-error">{t(errors[job.error])}</dd>
                    </>
                  )}
                </dl>
              </article>
            ))}
          </div>
          <p className="muted">
            {t('朗读任务记录合成或系统声音准备；播放暂停和停止使用划词工具中的控制。')}
          </p>
          <details className="task-capabilities">
            <summary>{t('可用后端与任务能力')}</summary>
            {(Object.keys(features) as ProviderFeature[]).map((feature) => (
              <section key={feature}>
                <h3>{t(features[feature])}</h3>
                <ul>
                  {capabilities
                    .filter((c) => c.feature === feature)
                    .map((c) => (
                      <li key={c.id}>
                        <strong>{c.id}</strong>
                        <span>
                          {t(
                            c.resource === 'local'
                              ? '本地模型'
                              : c.resource === 'system'
                                ? '系统离线声音'
                                : 'HTTP / API',
                          )}{' '}
                          · {t(c.input === 'image' ? '图片输入' : '文本输入')} ·{' '}
                          {t(
                            c.output === 'audio'
                              ? '音频输出'
                              : c.output === 'system'
                                ? '系统播放'
                                : '文本输出',
                          )}
                          {c.stream ? ` · ${t('流式文本')}` : ''} · {t('可取消')}
                        </span>
                        {!!c.models.length && <small>{c.models.join(' / ')}</small>}
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </details>
        </div>
      </section>
    </div>
  );
}
