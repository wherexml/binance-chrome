// 测试翻页逻辑的脚本 - 增强版
// 在浏览器控制台中运行此脚本来测试翻页功能

console.log('=== 测试翻页逻辑 ===');

function testPaginationAdvanced() {
  // 检查当前页码信息
  function getCurrentPageInfo() {
    // 方法1: 查找disabled的页码按钮（当前页）
    let currentPage = 1;
    const activePageBtn = document.querySelector('button[disabled][id^="page-"]:not([id*="next"]):not([id*="previous"])');
    if (activePageBtn) {
      const pageText = activePageBtn.textContent.trim();
      if (!isNaN(pageText)) {
        currentPage = parseInt(pageText);
      }
    } else {
      // 方法2: 查找有特殊class的当前页按钮
      const activeBtn = document.querySelector('button[id^="page-"].css-192p1dx');
      if (activeBtn) {
        const pageText = activeBtn.textContent.trim();
        if (!isNaN(pageText)) {
          currentPage = parseInt(pageText);
        }
      }
    }
    
    // 查找最大可见页码
    let totalPages = currentPage;
    const allPageButtons = document.querySelectorAll('button[id^="page-"]:not([id*="next"]):not([id*="previous"])');
    allPageButtons.forEach(btn => {
      const pageText = btn.textContent.trim();
      if (!isNaN(pageText) && pageText !== '...') {
        const pageNum = parseInt(pageText);
        if (pageNum > totalPages) {
          totalPages = pageNum;
        }
      }
    });
    
    return { current: currentPage, total: totalPages };
  }

  // 测试下一页按钮检测 - 完全模拟插件逻辑
  function testNextButton() {
    console.log('=== 详细检测下一页按钮 ===');
    
    const candidates = [
      {
        selector: 'button[id="next-page"]',
        name: 'ID为next-page的按钮'
      },
      {
        selector: '.css-1j0atjd',
        name: '特定CSS类的按钮'
      },
      {
        selector: '.css-4t2hsn button:last-child',
        name: '分页容器最后一个按钮'
      },
      {
        selector: 'button[aria-label*="Next page"]',
        name: 'aria-label包含Next page的按钮'
      }
    ];
    
    let nextButton = null;
    let buttonInfo = null;
    
    // 逐个检查候选按钮
    for (const candidate of candidates) {
      try {
        const btn = document.querySelector(candidate.selector);
        console.log(`检查${candidate.name}: ${btn ? '找到' : '未找到'}`);
        
        if (btn) {
          const isDisabled = btn.disabled || 
                            btn.getAttribute("aria-disabled") === "true" ||
                            btn.hasAttribute('disabled');
          
          console.log(`  - disabled属性: ${btn.disabled}`);
          console.log(`  - aria-disabled: ${btn.getAttribute("aria-disabled")}`);
          console.log(`  - hasAttribute disabled: ${btn.hasAttribute('disabled')}`);
          console.log(`  - className: ${btn.className}`);
          
          // 样式检查
          const computedStyle = window.getComputedStyle(btn);
          console.log(`  - pointerEvents: ${computedStyle.pointerEvents}`);
          console.log(`  - cursor: ${computedStyle.cursor}`);
          console.log(`  - display: ${computedStyle.display}`);
          
          if (!isDisabled) {
            nextButton = btn;
            buttonInfo = candidate;
            console.log(`✅ 选中${candidate.name}作为下一页按钮`);
            break;
          } else {
            console.log(`❌ ${candidate.name}已禁用`);
          }
        }
      } catch (e) {
        console.log(`检查${candidate.name}时出错:`, e);
      }
    }
    
    return { button: nextButton, info: buttonInfo };
  }

  // 检查所有分页相关元素
  function checkPaginationElements() {
    console.log('\n=== 分页元素检查 ===');
    
    // 所有页码按钮
    const allPageBtns = document.querySelectorAll('button[id^="page-"]');
    console.log(`总页码按钮数: ${allPageBtns.length}`);
    allPageBtns.forEach((btn, idx) => {
      console.log(`${idx + 1}. ${btn.id}: "${btn.textContent.trim()}" (disabled: ${btn.disabled})`);
    });
    
    // 分页容器
    const paginationContainer = document.querySelector('.css-4t2hsn');
    if (paginationContainer) {
      console.log('分页容器内容:', paginationContainer.innerHTML.substring(0, 200) + '...');
    }
    
    // 表格内容
    const tableRows = document.querySelectorAll('.bn-web-table-tbody tr:not(.bn-web-table-measure-row)');
    console.log(`表格数据行数: ${tableRows.length}`);
    
    if (tableRows.length > 0) {
      const firstRow = tableRows[0];
      const timeCell = firstRow.querySelector('td:first-child');
      console.log(`第一行时间: ${timeCell ? timeCell.textContent.trim() : '未找到'}`);
    }
  }

  // 主测试逻辑
  const pageInfo = getCurrentPageInfo();
  console.log('当前页码信息:', pageInfo);
  
  const buttonTest = testNextButton();
  
  checkPaginationElements();
  
  // 判断结论
  console.log('\n=== 测试结论 ===');
  if (buttonTest.button) {
    console.log('✅ 找到可用的下一页按钮，可以继续翻页');
    console.log(`推荐使用: ${buttonTest.info.name}`);
  } else {
    console.log('❌ 没有找到可用的下一页按钮，应该停止翻页');
  }
  
  if (pageInfo.current >= pageInfo.total) {
    console.log(`⚠️ 当前页(${pageInfo.current}) >= 最大页(${pageInfo.total})，可能已到最后一页`);
  }
  
  return {
    pageInfo,
    hasNextButton: !!buttonTest.button,
    buttonInfo: buttonTest.info
  };
}

// 运行增强测试并显示结果
try {
  const result = testPaginationAdvanced();
  console.log('\n最终测试结果:', result);
  
  // 在页面上显示测试结果
  const resultDiv = document.createElement('div');
  resultDiv.id = 'pagination-test-result';
  resultDiv.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: #000;
    color: #0f0;
    padding: 15px;
    border: 2px solid #0f0;
    font-family: monospace;
    font-size: 12px;
    max-width: 400px;
    z-index: 9999;
    border-radius: 5px;
  `;
  
  const resultText = `
=== 翻页测试结果 ===
当前页: ${result.pageInfo.current}
总页数: ${result.pageInfo.total}
可以翻页: ${result.hasNextButton ? '是' : '否'}
${result.buttonInfo ? '使用按钮: ' + result.buttonInfo.name : ''}

表格行数: ${document.querySelectorAll('.bn-web-table-tbody tr:not(.bn-web-table-measure-row)').length}

点击此框关闭结果
  `.trim();
  
  resultDiv.textContent = resultText;
  resultDiv.onclick = () => resultDiv.remove();
  
  // 移除之前的结果
  const existingResult = document.getElementById('pagination-test-result');
  if (existingResult) {
    existingResult.remove();
  }
  
  document.body.appendChild(resultDiv);
  
  // 5秒后自动消失
  setTimeout(() => {
    if (resultDiv.parentNode) {
      resultDiv.remove();
    }
  }, 10000);
  
} catch (error) {
  console.error('测试脚本执行错误:', error);
  alert('测试脚本执行错误: ' + error.message);
}